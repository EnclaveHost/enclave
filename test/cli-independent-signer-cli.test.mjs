// The PATCHED cli/enclave.mjs (work/independent-signer-integration/*.patch applied) with an external signer, as a
// subprocess against a real local chain: anvil on chain 8453 read through two RPC origins (anvil and a forwarder on a
// second port), wallets that are a SEPARATE anvil behind JSON-RPC fixtures. Only anvil's published dev keys are used.
// ENCLAVE_CLI_ENTRY runs the same cases against the built bundle (cli/build.mjs).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http as viemHttp, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = process.env.ENCLAVE_CLI_ENTRY ? path.resolve(process.env.ENCLAVE_CLI_ENTRY) : path.join(REPO, "cli", "enclave.mjs");
const A0 = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const A1 = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const local = defineChain({ id: 8453, name: "local-base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } });
const patched = fs.readFileSync(CLI, "utf8").includes("cmdSigner");
const tools = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); } catch { return "needs Foundry's anvil"; } return patched ? null : "needs the integration patches applied"; })();
const T = tools ? { skip: tools } : { timeout: 120000 };

const procs = [], servers = [];
let chainRpc, forwarderRpc, walletRpc, pc, tmp, pins;
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
async function anvil() {
  const port = await freePort();
  procs.push(spawn("anvil", ["--port", String(port), "--chain-id", "8453", "--silent", "--base-fee", "5000000"], { stdio: "ignore" }));
  const url = `http://127.0.0.1:${port}`, c = createPublicClient({ chain: local, transport: viemHttp(url) });
  for (let i = 0; i < 100; i++) { try { await c.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  return url;
}
const call = async (url, method, params = []) => {
  const j = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  return "error" in j ? { error: j.error } : { result: j.result };
};
async function server(handler) {
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    let b = ""; for await (const c of req) b += c;
    const m = JSON.parse(b);
    const one = async (x) => { calls.push(x.method); return { jsonrpc: "2.0", id: x.id, ...(await handler(x)) }; };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Array.isArray(m) ? await Promise.all(m.map(one)) : await one(m)));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  servers.push(srv);
  return { url: `http://127.0.0.1:${srv.address().port}`, calls };
}
function cli(args, { home }) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), ENCLAVE_ADDRESS_BOOK: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}
const IND = () => ["--independent", "--contract-pins", pins, "--rpc", `${chainRpc},${forwarderRpc}`, "--confirmations", "0"];
const fund = (eth = "0.001") => ["--yes", "host", "fund", "--address", A1.address, "--eth", eth];

before(async () => {
  if (tools) return;
  chainRpc = await anvil();
  walletRpc = await anvil();
  pc = createPublicClient({ chain: local, transport: viemHttp(chainRpc) });
  forwarderRpc = (await server((m) => call(chainRpc, m.method, m.params))).url;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-ind-signer-cli-"));
  pins = path.join(tmp, "pins.json");
  const a = (n) => "0x" + n.toString(16).padStart(40, "0");
  fs.writeFileSync(pins, JSON.stringify({ version: 1, chainId: 8453, contracts: { registry: a(1), deployments: a(2), appCatalog: a(3), proofOfTime: a(4),
    enclavePay: a(0), verificationFees: a(0), sessionVaultFactory: a(0), secretVaultV2: a(0) } }));
});
after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } for (const p of procs) p.kill("SIGKILL"); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test("patched CLI: --signer signs only; the quorum prepares, broadcasts and confirms one transaction; signer list shows the intent", T, async () => {
  const home = path.join(tmp, "h1");
  const wallet = await server((m) => call(walletRpc, m.method, m.params));
  const n0 = await pc.getTransactionCount({ address: A0.address }), b0 = await pc.getBalance({ address: A1.address });
  const r = await cli([...IND(), "--signer", wallet.url, "--from", A0.address, ...fund()], { home });
  assert.equal(r.code, 0, r.err); assert.match(r.out, /✓ funded \(tx 0x[0-9a-f]{64}, confirmed by 2 RPCs\)/);
  assert.match(r.err, /signer: .*signed 0x[0-9a-f]{64} \(intent tx-/);
  assert.equal(await pc.getTransactionCount({ address: A0.address }), n0 + 1);
  assert.equal(await pc.getBalance({ address: A1.address }), b0 + 10n ** 15n);
  assert.equal(wallet.calls.filter((m) => m === "eth_signTransaction").length, 1);
  assert.ok(!wallet.calls.some((m) => /getTransactionCount|estimateGas|gasPrice|feeHistory|sendRawTransaction|sendTransaction|getBalance/.test(m)), wallet.calls.join());
  const l = await cli([...IND(), "--json", "signer", "list"], { home });
  assert.equal(l.code, 0, l.err);
  const intents = JSON.parse(l.out).intents;
  assert.equal(intents.length, 1); assert.equal(intents[0].state, "confirmed"); assert.equal(intents[0].raw, undefined);
});

test("patched CLI: a broadcast-only wallet is used in auto mode (announced), refused in sign mode; --from is required", T, async () => {
  const home = path.join(tmp, "h2");
  const sendOnly = await server((m) => m.method === "eth_signTransaction" ? { error: { code: -32601, message: "Method not found" } } : call(chainRpc, m.method, m.params));
  const strict = await cli([...IND(), "--signer", sendOnly.url, "--signer-mode", "sign", "--from", A0.address, ...fund()], { home });
  assert.notEqual(strict.code, 0); assert.match(strict.err, /does not offer eth_signTransaction; nothing was broadcast/);
  const n0 = await pc.getTransactionCount({ address: A0.address });
  const r = await cli([...IND(), "--signer", sendOnly.url, "--from", A0.address, ...fund()], { home });
  assert.equal(r.code, 0, r.err); assert.match(r.err, /cannot sign without broadcasting.*weaker/);
  assert.equal(await pc.getTransactionCount({ address: A0.address }), n0 + 1);
  assert.equal(sendOnly.calls.filter((m) => m === "eth_sendTransaction").length, 1);
  const nf = await cli([...IND(), "--signer", sendOnly.url, ...fund()], { home });
  assert.notEqual(nf.code, 0); assert.match(nf.err, /--signer needs --from/);
  const stray = await cli(["--signer-mode", "sign", "whoami"], { home });
  assert.notEqual(stray.code, 0); assert.match(stray.err, /apply to independent mode/);
});

test("patched CLI: handoff prints the exact transaction and exits; signer attach confirms the user's own send by quorum", T, async () => {
  const home = path.join(tmp, "h3");
  const h = await cli([...IND(), "--json", "--signer-mode", "handoff", "--from", A0.address, ...fund()], { home });
  assert.equal(h.code, 0, h.err);
  const { handoff, transaction } = JSON.parse(h.out.slice(h.out.indexOf("{\n")));   // host fund prints its intent first
  assert.match(handoff, /^tx-/); assert.equal(transaction.to.toLowerCase(), A1.address.toLowerCase()); assert.equal(transaction.value, "0x38d7ea4c68000");
  const busy = await cli([...IND(), "--signer-mode", "handoff", "--from", A0.address, ...fund()], { home });
  assert.notEqual(busy.code, 0); assert.match(busy.err, new RegExp(`intent ${handoff}.*unresolved`));
  const sent = await createWalletClient({ chain: local, account: A0, transport: viemHttp(chainRpc) }).request({ method: "eth_sendTransaction", params: [transaction] });
  const a = await cli([...IND(), "signer", "attach", handoff, sent], { home });
  assert.equal(a.code, 0, a.err); assert.match(a.out, new RegExp(`confirmed: ${sent}`));
});

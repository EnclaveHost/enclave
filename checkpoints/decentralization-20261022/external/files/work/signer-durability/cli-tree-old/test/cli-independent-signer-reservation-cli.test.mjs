// The CLI (cli/enclave.mjs, or the built bundle via ENCLAVE_CLI_ENTRY) with an external signer: one send in flight per
// account and journal across separate CLI processes, recovery from a CLI killed mid-send, and an unreadable journal
// file. The chain is anvil (chain 8453) read through two RPC origins; the second origin is a forwarder that can HOLD
// every pending-nonce read, so two CLI processes are forced into the interleaving that raced before (both past the busy
// check, both about to read nonce N). Only anvil's published dev keys are used; nothing leaves 127.0.0.1.
//   run: node --test --test-concurrency=1 test/cli-independent-signer-reservation-cli.test.mjs
//   bundle: ENCLAVE_CLI_ENTRY=cli/dist/enclave.mjs node --test ...
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPublicClient, http as viemHttp, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = process.env.ENCLAVE_CLI_ENTRY ? path.resolve(process.env.ENCLAVE_CLI_ENTRY) : path.join(REPO, "cli", "enclave.mjs");
const A0 = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const A1 = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const local = defineChain({ id: 8453, name: "local-base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } });
const integrated = fs.readFileSync(CLI, "utf8").includes("signer attach");
const tools = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); } catch { return "needs Foundry's anvil"; } return integrated ? null : "needs the external-signer CLI integration"; })();
const T = tools ? { skip: tools } : { timeout: 120000 };

const procs = [], servers = [], clis = new Set();
let chainRpc, forwarderRpc, tmp, pins;
const held = [];            // pending-nonce reads held at the forwarder: [release]
let holding = false;
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const call = async (url, method, params = []) => {
  const j = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  return "error" in j ? { error: j.error } : { result: j.result };
};
const until = async (pred, ms, what) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 10)); } };
const releaseAll = () => { holding = false; for (const go of held.splice(0)) go(); };

before(async () => {
  if (tools) return;
  const port = await freePort();
  procs.push(spawn("anvil", ["--port", String(port), "--chain-id", "8453", "--silent", "--base-fee", "5000000"], { stdio: "ignore" }));
  chainRpc = `http://127.0.0.1:${port}`;
  const pc = createPublicClient({ chain: local, transport: viemHttp(chainRpc) });
  for (let i = 0; i < 100; i++) { try { await pc.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const srv = http.createServer(async (req, res) => {
    let b = ""; for await (const c of req) b += c;
    const m = JSON.parse(b);
    const one = async (x) => {
      if (holding && x.method === "eth_getTransactionCount" && x.params?.[1] === "pending") await new Promise((go) => held.push(go));
      return { jsonrpc: "2.0", id: x.id, ...(await call(chainRpc, x.method, x.params)) };
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Array.isArray(m) ? await Promise.all(m.map(one)) : await one(m)));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  servers.push(srv);
  forwarderRpc = `http://127.0.0.1:${srv.address().port}`;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-signer-reservation-"));
  pins = path.join(tmp, "pins.json");
  const a = (n) => "0x" + n.toString(16).padStart(40, "0");
  fs.writeFileSync(pins, JSON.stringify({ version: 1, chainId: 8453, contracts: { registry: a(1), deployments: a(2), appCatalog: a(3), proofOfTime: a(4),
    enclavePay: a(0), verificationFees: a(0), sessionVaultFactory: a(0), secretVaultV2: a(0) } }));
});
after(() => { releaseAll(); for (const p of clis) p.kill("SIGKILL"); for (const s of servers) { s.closeAllConnections(); s.close(); } for (const p of procs) p.kill("SIGKILL"); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

function cli(args, { home }) {
  const p = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), ENCLAVE_ADDRESS_BOOK: "" }, stdio: ["ignore", "pipe", "pipe"] });
  clis.add(p);
  let out = "", err = "";
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
  const done = new Promise((resolve) => p.on("close", (code, signal) => { clis.delete(p); resolve({ code, signal, out, err }); }));
  return Object.assign(done, { p, exited: () => !clis.has(p) });
}
const IND = (home) => ["--independent", "--contract-pins", pins, "--rpc", `${chainRpc},${forwarderRpc}`, "--confirmations", "0", "--state-dir", path.join(home, "state")];
const handoff = (home) => [...IND(home), "--json", "--signer-mode", "handoff", "--from", A0.address, "--yes", "host", "fund", "--address", A1.address, "--eth", "0.001"];
const handoffOf = (r) => { const i = r.out.indexOf("{\n"); return i < 0 ? null : JSON.parse(r.out.slice(i)); };
const list = async (home) => { const l = await cli([...IND(home), "--json", "signer", "list"], { home }); assert.equal(l.code, 0, l.err); return JSON.parse(l.out); };

test("two CLI processes on one state dir, held at the pending-nonce read: one handoff; the other is refused before reading the nonce", T, async () => {
  const home = path.join(tmp, "race");
  holding = true;
  const runs = [cli(handoff(home), { home }), cli(handoff(home), { home })];
  await until(() => held.length + runs.filter((r) => r.exited()).length >= 2, 30000, "both CLIs at the nonce read or finished");
  const heldBeforeGo = held.length;
  releaseAll();
  const [a, b] = await Promise.all(runs);
  const handed = [a, b].map(handoffOf).filter(Boolean);
  assert.equal(handed.length, 1, `handoffs printed: ${handed.length} (${handed.map((h) => `${h.handoff} nonce ${h.transaction.nonce}`).join("; ")})`);
  assert.equal(heldBeforeGo, 1, "only one CLI reached the pending-nonce read");
  const refused = [a, b].find((r) => !handoffOf(r));
  assert.notEqual(refused.code, 0); assert.match(refused.err, /signing reservation|is unresolved/);
  const l = await list(home);
  assert.equal(l.intents.filter((r) => r.state === "handoff").length, 1);
  assert.equal(l.reservations.length, 1); assert.equal(l.reservations[0].intent, handed[0].handoff);
});

test("a CLI killed after taking the reservation: the next CLI is refused and names it; signer release (explicit) lets sends go on", T, async () => {
  const home = path.join(tmp, "killed");
  holding = true;
  const run = cli(handoff(home), { home });
  await until(() => held.length === 1, 30000, "the CLI at the nonce read");
  run.p.kill("SIGKILL");
  assert.equal((await run).signal, "SIGKILL");
  releaseAll();
  const l = await list(home);
  assert.deepEqual(l.intents, []); assert.equal(l.reservations.length, 1);
  assert.equal(l.reservations[0].intent, null); assert.equal(l.reservations[0].pid, run.p.pid);
  const key = l.reservations[0].key;
  const busy = await cli(handoff(home), { home });
  assert.notEqual(busy.code, 0); assert.match(busy.err, new RegExp(`signing reservation ${key.replace(/[/]/g, "\\/")}.*signer release ${key.replace(/[/]/g, "\\/")}`, "s"));
  const text = await cli([...IND(home), "signer", "list"], { home });
  assert.match(text.out, /held with no intent recorded .*signer release/);
  const rel = await cli([...IND(home), "signer", "release", key], { home });
  assert.equal(rel.code, 0, rel.err); assert.match(rel.out, /released/);
  const ok = await cli(handoff(home), { home });
  assert.equal(ok.code, 0, ok.err); assert.match(handoffOf(ok).handoff, /^tx-/);
});

test("an unreadable intent file stops every CLI send (its content never printed) until signer quarantine sets it aside", T, async () => {
  const home = path.join(tmp, "unreadable");
  const dir = path.join(home, "state", "signer");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "tx-corrupt1-deadbeef.json"), `{"format":"enclave-signer-intent/v1","raw":"0x02f8${"cd".repeat(60)}","sta`, { mode: 0o600 });
  const r = await cli(handoff(home), { home });
  assert.notEqual(r.code, 0); assert.match(r.err, /cannot be read .*signer quarantine tx-corrupt1-deadbeef/);
  const l = await cli([...IND(home), "signer", "list"], { home });
  assert.match(l.out, /UNREADABLE tx-corrupt1-deadbeef\.json/);
  for (const x of [r.err, r.out, l.out, l.err]) assert.ok(!x.includes("cdcdcdcd"), "the file's content is never printed");
  const q = await cli([...IND(home), "signer", "quarantine", "tx-corrupt1-deadbeef"], { home });
  assert.equal(q.code, 0, q.err); assert.match(q.out, /set aside/);
  const ok = await cli(handoff(home), { home });
  assert.equal(ok.code, 0, ok.err);
});

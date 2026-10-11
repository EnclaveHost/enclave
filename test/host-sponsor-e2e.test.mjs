// The sponsored registration end to end on a FORK OF BASE (anvil): the relay's sponsor routes (relay/host-sponsor.mjs)
// over HTTP, the node's client (windows/node/sponsor.mjs), EnclaveHostPaymaster deployed on the fork with a deposit,
// the real EntryPoint v0.8, Simple7702Account and the live EnclaveRegistry. A fresh operator key holding NO ETH
// registers its box; then the refusals. Skipped unless BASE_FORK_RPC is set and anvil and forge are installed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { generateKeyPairSync, createHash } from "node:crypto";
import { createPublicClient, createWalletClient, http as vhttp, parseAbiItem, parseEther, getAddress, defineChain } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { hostSponsor, hostSponsorRouter, sponsorMessage as relayMessage } from "../relay/host-sponsor.mjs";
import { sponsoredRegister, sponsorMessage as nodeMessage, ENTRYPOINT_08 } from "../windows/node/sponsor.mjs";

const RPC = process.env.BASE_FORK_RPC || "";
const has = (cmd) => { try { execFileSync(cmd, ["--version"], { stdio: "ignore" }); return true; } catch { return false; } };
const skip = !RPC || !has("anvil") || !has("forge") ? "BASE_FORK_RPC, anvil and forge are needed" : false;
const REGISTRY = "0x868eB7fc5B5A84B2FF082eafc9bf40b7AAc5CCAC";
const PORT = 18545 + Math.floor(Math.random() * 1000);
const ANVIL0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";   // anvil's well-known dev keys
const ANVIL1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
let anvil, server, client, relayBase, paymaster, hub;
const chain = defineChain({ id: 8453, name: "base-fork", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [`http://127.0.0.1:${PORT}`] } } });

function box(name) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const operatorKey = generatePrivateKey();
  const operator = privateKeyToAccount(operatorKey);
  const ek = createHash("sha256").update("ek of " + name + Math.random()).digest("hex");
  hub.set(name, { name, mode: "hv-node", spki: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
                  hvNode: { boot: { ekCertSha256: ek } }, claimant: operator.address });
  return { name, transportKey: privateKey, operator, ek };
}
const args = (name, extra = {}) => ({ endpoint: `https://api.enclave.host/t/${name}`, repo: "EnclaveHost/enclave",
  measurement: "0x" + "00".repeat(32), cpuPricePerSec6: 12, gpuPricePerSec6: 0, proofKey: "0x0000000000000000000000000000000000000000", ...extra });
const register = (b, a = args(b.name)) => sponsoredRegister({ relayBase, name: b.name, transportKey: b.transportKey, operator: b.operator,
                                                             client, registry: REGISTRY, args: a });

before(async () => {
  if (skip) return;
  anvil = spawn("anvil", ["--fork-url", RPC, "--port", String(PORT), "--silent", "--retries", "12", "--fork-retry-backoff", "1500", "--compute-units-per-second", "60"], { stdio: "ignore" });
  client = createPublicClient({ chain, transport: vhttp(`http://127.0.0.1:${PORT}`, { timeout: 90_000 }) });
  for (let i = 0; i < 100; i++) { try { await client.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 300)); } }
  // warm the fork with what the flow touches (a cold fork fetches each account from the RPC, slowly)
  await Promise.all([ENTRYPOINT_08, REGISTRY, "0xe6Cae83BdE06E4c305530e199D7217f42808555B"].map((a) => client.getCode({ address: a })));
  // deploy the paymaster on the fork (verifier = a fresh key the relay holds; cost cap 0.001 ETH) and fund it
  const verifierKey = generatePrivateKey();
  const out = execFileSync("forge", ["create", "contracts/EnclaveHostPaymaster.sol:EnclaveHostPaymaster", "--broadcast", "--rpc-url",
    `http://127.0.0.1:${PORT}`, "--private-key", ANVIL0, "--constructor-args", ENTRYPOINT_08, REGISTRY,
    privateKeyToAccount(verifierKey).address, String(parseEther("0.001"))], { encoding: "utf8" });
  paymaster = getAddress(/Deployed to: (0x[0-9a-fA-F]{40})/.exec(out)[1]);
  const owner = createWalletClient({ chain, account: privateKeyToAccount(ANVIL0), transport: vhttp(`http://127.0.0.1:${PORT}`, { timeout: 90_000 }) });
  await client.waitForTransactionReceipt({ hash: await owner.writeContract({ address: paymaster, abi: [parseAbiItem("function deposit() payable")],
                                                                              functionName: "deposit", value: parseEther("0.01") }) });
  hub = new Map();
  const sponsor = hostSponsor({ hub: { info: (n) => hub.get(n) || null }, endpointOf: (n) => `https://api.enclave.host/t/${n}`, ownerOf: async () => "",
                                verifierKey, bundlerKey: ANVIL1, paymaster, registry: REGISTRY, rpc: `http://127.0.0.1:${PORT}`,
                                client, wallet: createWalletClient({ chain, account: privateKeyToAccount(ANVIL1), transport: vhttp(`http://127.0.0.1:${PORT}`, { timeout: 90_000 }) }) });
  const route = hostSponsorRouter({ sponsor, json: (res, s, b) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); },
    readBody: (req) => new Promise((r) => { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => r(Buffer.concat(c))); }) });
  server = http.createServer(async (req, res) => { if (!(await route(req, res, new URL(req.url, "http://x")))) { res.writeHead(404); res.end(); } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  relayBase = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); anvil?.kill(); });

test("the node and the relay sign the same request message", { skip: false }, () => {
  const op = { sender: "0x" + "ab".repeat(20), nonce: "0", callData: "0x01", paymasterGasLimits: "0x" + "00".repeat(32) };
  assert.equal(nodeMessage("voucher", "box", op, "aa".repeat(16)), relayMessage("voucher", "box", op, "aa".repeat(16)));
});

test("a fresh operator key with NO ETH registers its box through the paymaster", { skip }, async () => {
  const b = box("sponsor-e2e-" + Date.now());
  assert.equal(await client.getBalance({ address: b.operator.address }), 0n);
  const before = await client.getBalance({ address: ENTRYPOINT_08 });
  const r = await register(b);
  assert.equal(r.success, true, JSON.stringify(r));
  const logs = await client.getLogs({ address: REGISTRY, event: parseAbiItem("event Registered(bytes32 indexed id, address indexed operator, string endpoint, string repo)"),
                                      args: { operator: b.operator.address }, fromBlock: (await client.getBlockNumber()) - 3n });
  assert.equal(logs.length, 1); assert.equal(logs[0].args.endpoint, `https://api.enclave.host/t/${b.name}`);
  assert.equal(await client.getBalance({ address: b.operator.address }), 0n, "and still holds none");
  assert.ok((await client.getBalance({ address: ENTRYPOINT_08 })) < before, "the paymaster's deposit paid");
});

test("refused: the same TPM again, another endpoint, a forged transport signature, a sender other than the one named at attach", { skip }, async () => {
  const b = box("sponsor-e2e-twice-" + Date.now());
  assert.equal((await register(b)).success, true);
  // the same TPM under a new name and key
  const again = box("sponsor-e2e-again-" + Date.now()); hub.get(again.name).hvNode.boot.ekCertSha256 = b.ek;
  await assert.rejects(register(again), /registration was sponsored already/);
  // someone else's endpoint
  const c = box("sponsor-e2e-other-" + Date.now());
  await assert.rejects(register(c, args("someone-else")), /registers https:\/\/api\.enclave\.host\/t\/sponsor-e2e-other/);
  // a transport key the relay never attested
  await assert.rejects(register({ ...c, transportKey: generateKeyPairSync("ed25519").privateKey }), /not signed by this tunnel's attested transport key/);
  // an operator key the box did not name at attach
  await assert.rejects(register({ ...c, operator: privateKeyToAccount(generatePrivateKey()) }), /must be the operator key this box named at attach/);
  // a box that is not hardware-attested (no hv-node verdict)
  const d = box("sponsor-e2e-unattested-" + Date.now()); delete hub.get(d.name).hvNode;
  await assert.rejects(register(d), /proved its hardware/);
});

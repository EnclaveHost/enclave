// End to end on a LOCAL anvil (chain id 8453, no fork, nothing upstream): the ACTUAL EntryPoint v0.8, Simple7702Account
// and SenderCreator runtime code (fixtures/aa-code-base.json, read once from Base and hash-pinned) set at their
// canonical addresses; the LIVE rev-16d ledger and schema-4 registry sources and the repo's EnclaveHostPaymaster built
// by forge (forge/out); MockUSDC and a mock ETH/USD feed. Real type-4 transactions, real handleOps.
//
//   - host A registers with ZERO ETH through the repo's own sponsored-registration path (relay/host-sponsor.mjs over
//     HTTP + windows/node/sponsor.mjs), which also delegates its key to Simple7702Account;
//   - host B is registered by a fixture shortcut (temporary ETH, then set back to 0): its FIRST lease operation carries
//     its EIP-7702 authorization;
//   - both claim and renew through client/lease-gas-client.mjs, signing locally; two independent submitters (and a
//     minimal bundler-style JSON-RPC endpoint with fallback) relay; the apps' budgets pay, the hosts never hold ETH;
//   - the paymaster's validation is traced (debug_traceCall) and checked against ERC-7562 by test/erc7562-check.mjs,
//     with a negative control that must be flagged.
// Run: node --test test/lease-gas-e2e.test.mjs   (cwd work/app-lease-gas; needs anvil and forge/out)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { generateKeyPairSync, createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as viem from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import * as C from "../client/lease-gas-client.mjs";
import { check } from "./erc7562-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENCLAVE = path.resolve(ROOT, "../enclave");
const OUT = path.join(ROOT, "forge/out");
const { hostSponsor, hostSponsorRouter } = await import(pathToFileURL(path.join(ENCLAVE, "relay/host-sponsor.mjs")).href);
const { sponsoredRegister } = await import(pathToFileURL(path.join(ENCLAVE, "windows/node/sponsor.mjs")).href);
const { linkBytecode } = await import(pathToFileURL(path.join(ENCLAVE, "site/js/lib/contract-linker.js")).href);

const haveAnvil = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const T = { skip: !haveAnvil && "needs anvil", timeout: 300_000 };
// anvil's published dev keys (local chain only)
const DEV = ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"];
const KEY = { deployer: DEV[0], submitter1: DEV[1], submitter2: DEV[2], sponsor: DEV[3], relayBundler: DEV[4] };

let anvil, rpcUrl, pc, chain, relayServer, bundlerServer, A = {}, addr = {};
const charges = [];
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const rpc = async (method, params) => {
  const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`); return j.result;
};
const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(OUT, file, name + ".json"), "utf8")); return { abi: j.abi, bytecode: j.bytecode.object, links: j.bytecode.linkReferences || {} }; };
const wc = (key) => viem.createWalletClient({ chain, account: privateKeyToAccount(key), transport: viem.http(rpcUrl) });
async function send(key, tx) {
  const h = await wc(key).sendTransaction({ ...tx, gas: tx.gas || 8_000_000n });
  const rc = await pc.waitForTransactionReceipt({ hash: h });
  if (rc.status !== "success") throw new Error("reverted: " + (tx.label || ""));
  return rc;
}
async function deploy(key, a, args = [], libs = {}) {
  const bytecode = Object.keys(a.links).length ? linkBytecode(a.bytecode, a.links, libs) : a.bytecode;
  const rc = await send(key, { data: viem.encodeDeployData({ abi: a.abi, bytecode, args }) });
  return rc.contractAddress;
}
const write = (key, address, abi, functionName, args = [], value = 0n) =>
  send(key, { to: address, data: viem.encodeFunctionData({ abi, functionName, args }), value, label: functionName });
const read = (address, abi, functionName, args = []) => pc.readContract({ address, abi, functionName, args });
const now = async () => (await pc.getBlock()).timestamp;
async function warpTo(ts) { await rpc("evm_setNextBlockTimestamp", [Number(ts)]); await rpc("evm_mine", []); }
async function freshFeed() { await write(KEY.deployer, addr.feed, A.feed.abi, "set", [300000000000n, await now()]); }   // never future-dated: the paymaster refuses that

function limits() {
  return { maxFeePerGas: 200_000_000n, maxPriorityFeePerGas: 50_000_000n, maxVerificationGas: 150_000, minCallGas: 60_000,
    maxCallGas: 300_000, maxPreVerificationGas: 120_000, maxPaymasterVerificationGas: 300_000, minPostOpGas: 100_000,
    maxPostOpGas: 150_000, postOpChargeGas: 50_000, markupBps: 500, minRenewWindow: 60, maxRenewWindow: 900,
    minExtensionFloor: 60, maxFailures: 2 };
}

/** Collect the paymaster's LeaseGasCharged events of a receipt. */
function chargedIn(receipt) {
  for (const l of receipt.logs) {
    if (viem.getAddress(l.address) !== viem.getAddress(addr.pm)) continue;
    try { const ev = viem.decodeEventLog({ abi: A.pm.abi, data: l.data, topics: l.topics });
      if (ev.eventName === "LeaseGasCharged") charges.push(ev.args); } catch {}
  }
}

/** The whole host-side flow: preflight, build, sign locally, submit through `submit`. */
async function leaseOp({ operator, kind, id, enclaveId, submit }) {
  const op = await C.buildLeaseOp({ client: pc, sender: operator.address, paymaster: addr.pm, sponsor: addr.sponsor, kind, id, enclaveId });
  await C.preflight({ client: pc, paymaster: addr.pm, id, op });
  const signed = await C.signLeaseOp({ client: pc, op, account: operator });
  return { signed, result: await submit(signed) };
}
const aaRaw = {}, aaGas = [];
const direct = (key) => async (s) => {
  const r = await C.submitDirect({ client: pc, wallet: wc(key), op: s.op, authorization: s.authorization });
  chargedIn(r.receipt);
  const kind = s.op.callData.includes("84cc9dfb") ? "claim" : "renew";
  const label = `${kind}${s.authorization ? "+auth" : ""}#${aaGas.length}`;
  aaGas.push({ label, bundleTxGasUsed: r.receipt.gasUsed, userOpActualGasUsed: r.actualGasUsed, success: r.success });
  aaRaw[label] = await rpc("eth_getRawTransactionByHash", [r.hash]);
  console.log(`# AA ${label}: bundle tx receipt gasUsed ${r.receipt.gasUsed}, userOp actualGasUsed ${r.actualGasUsed}`);
  return r;
};

before(async () => {
  if (!haveAnvil) return;
  const port = await freePort();
  rpcUrl = `http://127.0.0.1:${port}`;
  chain = viem.defineChain({ id: 8453, name: "local-8453", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  anvil = spawn("anvil", ["--port", String(port), "--chain-id", "8453", "--base-fee", "10000000", "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { await rpc("eth_chainId", []); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  pc = viem.createPublicClient({ chain, transport: viem.http(rpcUrl) });

  // the actual EntryPoint v0.8 / Simple7702Account / SenderCreator code, hash-pinned
  const aa = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures/aa-code-base.json"), "utf8"));
  const PIN = { entryPoint08: "0x28f989233f4ffb52e4b168fb74df5dfa52fe0f846141774f5abc56c5604d8e46",
                simple7702Account: "0xcc7b633aef4b2543cb8f37522adf1a401f910f0f6b2430c1eecc11f401ccfcf3",
                senderCreator: "0xc69a1b3a000d570bc86eb096ee63a9014a17951ad616d720882ec61432b00fcf" };
  for (const [name, c] of Object.entries(aa.contracts)) {
    assert.equal(viem.keccak256(c.code), PIN[name], `${name} code is the pinned snapshot`);
    await rpc("anvil_setCode", [c.address, c.code]);
  }

  A = { usdc: art("MockUSDC.sol", "MockUSDC"), feed: art("LeaseGas.t.sol", "MockFeed"), registry: art("EnclaveRegistry.sol", "EnclaveRegistry"),
        lib: art("EnclaveDeployments.sol", "EnclaveLedgerBandwidth"), ledger: art("EnclaveDeployments.sol", "EnclaveDeployments"),
        hostPm: art("EnclaveHostPaymaster.sol", "EnclaveHostPaymaster"), pm: art("EnclaveLeaseGasPaymaster.sol", "EnclaveLeaseGasPaymaster") };
  addr.usdc = await deploy(KEY.deployer, A.usdc);
  addr.feed = await deploy(KEY.deployer, A.feed);
  await freshFeed();
  addr.registry = await deploy(KEY.deployer, A.registry);
  addr.lib = await deploy(KEY.deployer, A.lib);
  addr.payout = privateKeyToAccount(generatePrivateKey()).address;
  addr.ledger = await deploy(KEY.deployer, A.ledger, [addr.usdc, addr.payout, addr.registry, addr.feed],
                             { "src/live/EnclaveDeployments.sol:EnclaveLedgerBandwidth": addr.lib });
  assert.equal(((await pc.getCode({ address: addr.ledger })).length - 2) / 2, 24368, "the live rev-16d runtime size");
  const verifierKey = generatePrivateKey();
  addr.hostPm = await deploy(KEY.deployer, A.hostPm, [C.ENTRYPOINT_08, addr.registry, privateKeyToAccount(verifierKey).address, 10n ** 15n]);
  await write(KEY.deployer, addr.hostPm, A.hostPm.abi, "deposit", [], 10n ** 16n);
  addr.pm = await deploy(KEY.deployer, A.pm, [C.ENTRYPOINT_08, addr.ledger, addr.registry, addr.usdc, C.SIMPLE_7702, 3600n, addr.feed,
                                               3600, 100000000000n, 1000000000000n, limits()]);
  await write(KEY.deployer, addr.pm, A.pm.abi, "addStake", [86400], 10n ** 18n);
  addr.sponsor = privateKeyToAccount(KEY.sponsor).address;
  await write(KEY.sponsor, addr.pm, A.pm.abi, "sponsorDeposit", [], 5n * 10n ** 16n);

  // the relay's sponsored-registration route (the repo's code), on loopback
  const hub = new Map();
  const relayBundler = privateKeyToAccount(KEY.relayBundler);
  const sponsor = hostSponsor({ hub: { info: (n) => hub.get(n) || null }, endpointOf: (n) => `https://api.enclave.host/t/${n}`, ownerOf: async () => "",
    verifierKey, bundlerKey: KEY.relayBundler, paymaster: addr.hostPm, registry: addr.registry, rpc: rpcUrl, client: pc,
    wallet: viem.createWalletClient({ chain, account: relayBundler, transport: viem.http(rpcUrl) }) });
  const route = hostSponsorRouter({ sponsor, json: (res, s, b) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); },
    readBody: (req) => new Promise((r) => { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => r(Buffer.concat(c))); }) });
  relayServer = http.createServer((req, res) => route(req, res, new URL(req.url, "http://x")).then((h) => { if (!h) { res.writeHead(404); res.end(); } }));
  await new Promise((ok) => relayServer.listen(0, "127.0.0.1", ok));
  addr.relayBase = `http://127.0.0.1:${relayServer.address().port}`;
  addr.hub = hub;

  // a minimal bundler-style endpoint (eth_sendUserOperation -> handleOps from its own key). NOT a 7562-enforcing bundler.
  bundlerServer = http.createServer(async (req, res) => {
    const c = []; for await (const x of req) c.push(x);
    const { id, method, params } = JSON.parse(Buffer.concat(c).toString());
    const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id, ...o })); };
    if (method !== "eth_sendUserOperation") return reply({ error: { code: -32601, message: "method not found" } });
    const u = params[0], u16 = (v) => viem.pad(viem.toHex(BigInt(v)), { size: 16 });
    const op = { sender: u.sender, nonce: BigInt(u.nonce), initCode: "0x", callData: u.callData,
      accountGasLimits: viem.concat([u16(u.verificationGasLimit), u16(u.callGasLimit)]), preVerificationGas: BigInt(u.preVerificationGas),
      gasFees: viem.concat([u16(u.maxPriorityFeePerGas), u16(u.maxFeePerGas)]),
      paymasterAndData: viem.concat([u.paymaster, u16(u.paymasterVerificationGasLimit), u16(u.paymasterPostOpGasLimit), u.paymasterData]),
      signature: u.signature };
    const auth = u.eip7702Auth ? { address: u.eip7702Auth.address, chainId: Number(u.eip7702Auth.chainId), nonce: Number(u.eip7702Auth.nonce),
                                   yParity: Number(u.eip7702Auth.yParity), r: u.eip7702Auth.r, s: u.eip7702Auth.s } : null;
    try {
      const r = await C.submitDirect({ client: pc, wallet: wc(KEY.submitter2), op, authorization: auth });
      chargedIn(r.receipt);
      reply({ result: await read(C.ENTRYPOINT_08, C.EP_ABI, "getUserOpHash", [op]) });
    } catch (e) { reply({ error: { code: -32500, message: e.message.slice(0, 300) } }); }
  });
  await new Promise((ok) => bundlerServer.listen(0, "127.0.0.1", ok));
  addr.bundlerUrl = `http://127.0.0.1:${bundlerServer.address().port}`;
});

after(async () => {
  if (Object.keys(aaRaw).length) fs.writeFileSync(path.join(ROOT, "fixtures/representative-aa-txs.json"), JSON.stringify({
    note: "raw signed design-A handleOps transactions from test/lease-gas-e2e.test.mjs (local anvil, chain id 8453); for a read-only Base L1-fee measurement",
    txs: aaRaw, gas: aaGas.map((g) => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]))) }, null, 1) + "\n");
  relayServer?.close(); bundlerServer?.close();
  if (anvil) anvil.kill("SIGKILL");
});

const ERC20 = viem.parseAbi(["function approve(address,uint256) returns (bool)", "function mint(address,uint256)", "function balanceOf(address) view returns (uint256)"]);
async function owner(label) {
  const key = generatePrivateKey(), account = privateKeyToAccount(key);
  await rpc("anvil_setBalance", [account.address, "0xde0b6b3a7640000"]);   // the APP OWNER pays for its own transactions
  await write(KEY.deployer, addr.usdc, ERC20, "mint", [account.address, 50_000_000n]);
  await write(key, addr.usdc, ERC20, "approve", [addr.pm, 2n ** 255n]);
  await write(key, addr.usdc, ERC20, "approve", [addr.ledger, 2n ** 255n]);
  return { key, address: account.address, label };
}
async function create(o) {
  const args = ["catalog://app/0", 0, 500, 8080, "", true, "", "0x0000000000000000000000000000000000000000", 0n, 1000n];
  const { result } = await pc.simulateContract({ account: o.address, address: addr.ledger, abi: A.ledger.abi, functionName: "create", args });
  await write(o.key, addr.ledger, A.ledger.abi, "create", args);
  return result;
}
const row = (id) => read(addr.ledger, A.ledger.abi, "get", [id]);
const budget = async (id, who) => (await read(addr.pm, A.pm.abi, "budgetOf", [id, who])).balance6;
const ethOf = (a) => pc.getBalance({ address: a });

let hostA, hostB, encA, encB, alice, carol, appA, appZ;

test("a host registers with ZERO ETH via the existing host paymaster, then claims and renews an app's lease paid by the app's budget", T, async () => {
  // ---- host A: zero-ETH registration through the repo's relay + node client (delegates the key to Simple7702Account)
  hostA = privateKeyToAccount(generatePrivateKey());
  const name = "lease-gas-host-a";
  const { privateKey: transportKey, publicKey } = generateKeyPairSync("ed25519");
  addr.hub.set(name, { name, mode: "hv-node", spki: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
                       hvNode: { boot: { ekCertSha256: createHash("sha256").update("ek of " + name).digest("hex") } }, claimant: hostA.address });
  const reg = await sponsoredRegister({ relayBase: addr.relayBase, name, transportKey, operator: hostA, client: pc, registry: addr.registry,
    args: { endpoint: `https://api.enclave.host/t/${name}`, repo: "EnclaveHost/enclave", measurement: viem.pad("0x", { size: 32 }), cpuPricePerSec6: 1000,
            gpuPricePerSec6: 0, proofKey: "0x000000000000000000000000000000000000bEEF" } });
  assert.equal(reg.success, true, "registered");
  encA = viem.keccak256(viem.toBytes(`https://api.enclave.host/t/${name}`));
  assert.equal((await pc.getCode({ address: hostA.address })).toLowerCase(), viem.concat(["0xef0100", C.SIMPLE_7702]).toLowerCase());
  assert.equal(await ethOf(hostA.address), 0n, "host A has never held ETH");

  // ---- the app: alice funds compute AND gas in ONE call (the ledger's fundFor for compute), and authorizes sponsorship
  alice = await owner("alice");
  appA = await create(alice);
  const bal0 = (await row(appA)).balance6;
  await write(alice.key, addr.pm, A.pm.abi, "fundBoth", [appA, 3_000_000n, 1_000_000n]);
  assert.equal((await row(appA)).balance6 - bal0, 3_000_000n, "compute funded on the ledger");
  assert.equal(await budget(appA, alice.address), 1_000_000n, "gas budget funded");
  await assert.rejects(C.preflight({ client: pc, paymaster: addr.pm, id: appA }), (e) => e.code === "Disabled");
  await write(alice.key, addr.pm, A.pm.abi, "configureBudget", [appA, true, 500_000n, 2_000_000n, 300, 600]);

  // ---- NEGATIVE CONTROL: today's path (the operator sends claim itself) is impossible with zero ETH
  const direct0 = viem.encodeFunctionData({ abi: A.ledger.abi, functionName: "claim", args: [appA, encA] });
  await assert.rejects(viem.createWalletClient({ chain, account: hostA, transport: viem.http(rpcUrl) }).sendTransaction({ to: addr.ledger, data: direct0 }),
                       (e) => { console.log("# negative control (operator sends claim itself):", (e.shortMessage || e.message).split("\n")[0]); return /insufficient funds|exceeds the balance|funds for gas/i.test(e.shortMessage || e.message); }, "a zero-ETH operator cannot claim on its own");
  assert.equal((await row(appA)).runner, viem.pad("0x", { size: 32 }), "still unclaimed");

  // ---- claim, submitted by an independent submitter
  const claim = await leaseOp({ operator: hostA, kind: "claim", id: appA, enclaveId: encA, submit: direct(KEY.submitter1) });
  assert.equal(claim.signed.authorization, null, "already delegated at registration: no authorization needed");
  assert.equal(claim.result.success, true);
  let r = await row(appA);
  assert.equal(r.runner, encA); assert.equal(r.runnerOperator, hostA.address);
  const afterClaim = await budget(appA, alice.address);
  assert.ok(afterClaim < 1_000_000n, "the app's budget paid");
  console.log(`claim: gasUsed ${claim.result.actualGasUsed}, deposit cost ${claim.result.actualGasCost} wei, app charged ${1_000_000n - afterClaim} (USDC 6dp)`);

  // ---- a premature renew: refused by simulation, costs nobody anything
  await assert.rejects(leaseOp({ operator: hostA, kind: "renew", id: appA, submit: direct(KEY.submitter1) }),
                       (e) => e.code === "Simulation" && /AA32 paymaster expired or not due|AA33 reverted: no valid window/.test(e.message));
  // ---- inside the window: renew through the bundler-style endpoint, after a dead one (independent submitters)
  await warpTo(r.leaseUntil - 120n);
  await freshFeed();
  const renew = await leaseOp({ operator: hostA, kind: "renew", id: appA,
    submit: (s) => C.submitToBundlers({ urls: ["http://127.0.0.1:1", addr.bundlerUrl], op: s.op, authorization: s.authorization }) });
  assert.equal(renew.result.bundler, addr.bundlerUrl);
  const r2 = await row(appA);
  assert.equal(r2.leaseUntil, r.leaseUntil + 1800n, "renewed by a full quantum");
  assert.ok(await budget(appA, alice.address) < afterClaim, "the renewal was charged to the app too");
  assert.equal(await ethOf(hostA.address), 0n, "host A still holds no ETH");
});

test("a second host's first lease operation carries its 7702 authorization; a self-hosted rate-0 app renews only in its window", T, async () => {
  hostB = privateKeyToAccount(generatePrivateKey());
  // fixture shortcut: host B registers the classic way (temporary ETH), then its balance is set back to zero
  await rpc("anvil_setBalance", [hostB.address, "0xde0b6b3a7640000"]);
  const regData = viem.encodeFunctionData({ abi: A.registry.abi, functionName: "register",
    args: ["https://host-b.lease-gas.test", "EnclaveHost/enclave", viem.pad("0x", { size: 32 }), 1000n, 0n, "0x000000000000000000000000000000000000bEEF"] });
  const hB = await viem.createWalletClient({ chain, account: hostB, transport: viem.http(rpcUrl) }).sendTransaction({ to: addr.registry, data: regData });
  await pc.waitForTransactionReceipt({ hash: hB });
  await rpc("anvil_setBalance", [hostB.address, "0x0"]);
  encB = viem.keccak256(viem.toBytes("https://host-b.lease-gas.test"));
  assert.equal(await ethOf(hostB.address), 0n);
  assert.equal(await pc.getCode({ address: hostB.address }), undefined);

  // carol's own app on carol's box (host B declares carol as its payout wallet): free on the ledger (rate 0)
  carol = await owner("carol");
  appZ = await create(carol);
  await write(carol.key, addr.registry, A.registry.abi, "setPayoutWallet", [encB]);
  await write(carol.key, addr.pm, A.pm.abi, "fundBudget", [appZ, 1_000_000n]);
  await write(carol.key, addr.pm, A.pm.abi, "configureBudget", [appZ, true, 500_000n, 2_000_000n, 300, 600]);

  const claim = await leaseOp({ operator: hostB, kind: "claim", id: appZ, enclaveId: encB, submit: direct(KEY.submitter2) });
  assert.ok(claim.signed.authorization, "the first operation carried the 7702 authorization");
  assert.equal(claim.result.success, true);
  assert.equal((await pc.getCode({ address: hostB.address })).toLowerCase(), viem.concat(["0xef0100", C.SIMPLE_7702]).toLowerCase());
  const z = await row(appZ);
  assert.equal(z.rate, 0n, "self-hosted: rate 0");
  assert.equal(await ethOf(hostB.address), 0n, "host B paid nothing, not even for its delegation");
  // the ledger would take a free renew every block; the paymaster only in the window
  await assert.rejects(leaseOp({ operator: hostB, kind: "renew", id: appZ, submit: direct(KEY.submitter2) }), (e) => e.code === "Simulation" && /AA32 paymaster expired or not due|AA33 reverted: no valid window/.test(e.message));
  await warpTo(z.leaseUntil - 100n);
  await freshFeed();
  const renew = await leaseOp({ operator: hostB, kind: "renew", id: appZ, submit: direct(KEY.submitter1) });
  assert.equal(renew.signed.authorization, null);
  assert.equal(renew.result.success, true);
  await assert.rejects(leaseOp({ operator: hostB, kind: "renew", id: appZ, submit: direct(KEY.submitter2) }), (e) => e.code === "Simulation" && /AA32 paymaster expired or not due|AA33 reverted: no valid window/.test(e.message));
});

test("insufficient budget is an explicit state; the app's own money stays withdrawable; accounting balances", T, async () => {
  const left = await budget(appZ, carol.address);
  await write(carol.key, addr.pm, A.pm.abi, "withdrawBudget", [appZ, left, carol.address]);
  await assert.rejects(C.preflight({ client: pc, paymaster: addr.pm, id: appZ }), (e) => e.code === "InsufficientBudget" && /insufficient app gas budget/.test(e.message));
  // accounting: every charge reimbursed the sponsor exactly; the deposit covers all tracked sponsor ETH
  const total6 = charges.reduce((a, c) => a + c.charged6, 0n);
  const [, earned6] = await read(addr.pm, A.pm.abi, "sponsors", [addr.sponsor]);
  assert.equal(earned6, total6, "sponsor earned = sum of app charges");
  assert.equal(charges.length, 4, "two claims and two renewals were charged");
  const dep = await read(C.ENTRYPOINT_08, viem.parseAbi(["function balanceOf(address) view returns (uint256)"]), "balanceOf", [addr.pm]);
  assert.ok(dep >= await read(addr.pm, A.pm.abi, "totalSponsorEth"), "solvent: deposit >= tracked sponsor ETH");
  console.log("charges (wei / USDC 6dp):", charges.map((c) => `${c.kind === 1 ? "claim" : "renew"} ${c.chargedWei}/${c.charged6}`).join(", "));
  assert.equal(await ethOf(hostA.address) + await ethOf(hostB.address), 0n, "hosts never held ETH");
});

test("ERC-7562: the paymaster's validation (claim and renew) passes our trace check; a TIMESTAMP-using view is flagged", T, async () => {
  const codeOf = (a) => pc.getCode({ address: a }).then((c) => c || "0x");
  // a fresh claimable app for host A, and a renew-able one (host A holds appA)
  const appC = await create(alice);
  await write(alice.key, addr.ledger, A.ledger.abi, "fund", [appC, 3_000_000n]);
  await write(alice.key, addr.pm, A.pm.abi, "fundBudget", [appC, 1_000_000n]);
  await write(alice.key, addr.pm, A.pm.abi, "configureBudget", [appC, true, 500_000n, 2_000_000n, 300, 600]);
  await warpTo((await row(appA)).leaseUntil - 100n);                // inside appA's renew window, so both validations succeed
  await freshFeed();
  const results = {};
  for (const [kind, id, enc] of [["claim", appC, encA], ["renew", appA, undefined]]) {
    const op = await C.buildLeaseOp({ client: pc, sender: hostA.address, paymaster: addr.pm, sponsor: addr.sponsor, kind, id, enclaveId: enc });
    const signed = (await C.signLeaseOp({ client: pc, op, account: hostA })).op;
    const data = viem.encodeFunctionData({ abi: A.pm.abi, functionName: "validatePaymasterUserOp", args: [signed, viem.pad("0x", { size: 32 }), C.maxCostOf(signed)] });
    const tr = await rpc("debug_traceCall", [{ from: C.ENTRYPOINT_08, to: addr.pm, data, gas: "0x1000000" }, "latest", { disableStorage: true, enableMemory: false }]);
    assert.equal(tr.failed, false, `${kind} validation succeeded in the trace`);
    const res = await check({ logs: tr.structLogs, entity: addr.pm, sender: hostA.address, entryPoint: C.ENTRYPOINT_08, codeOf });
    results[kind] = res;
    console.log(`${kind}: ${tr.structLogs.length} steps, gas ${tr.gas}, reads ${JSON.stringify(res.reads)}, writes ${JSON.stringify(res.writes)}, violations ${JSON.stringify(res.violations)}`);
    assert.deepEqual(res.violations, [], `${kind}: no ERC-7562 violation found`);
    assert.deepEqual(Object.keys(res.writes), [addr.pm.toLowerCase()], "writes only its own (transient) storage");
    assert.ok(res.reads[addr.ledger.toLowerCase()] > 0, "reads the ledger (STO-033: staked)");
    if (kind === "claim") assert.ok(res.reads[addr.registry.toLowerCase()] > 0, "reads the registry (STO-033: staked)");
    assert.ok(res.reads[addr.feed.toLowerCase()] > 0, "reads the feed (STO-033: staked)");
    assert.equal(res.opcodes.TIMESTAMP || 0, 0); assert.equal(res.opcodes.NUMBER || 0, 0);
  }
  // NEGATIVE CONTROL: the ledger's own claimableBy() reads block.timestamp - the checker must flag it
  const bad = viem.encodeFunctionData({ abi: A.ledger.abi, functionName: "claimableBy", args: [appC, encA] });
  const tr = await rpc("debug_traceCall", [{ to: addr.ledger, data: bad }, "latest", { disableStorage: true, enableMemory: false }]);
  const res = await check({ logs: tr.structLogs, entity: addr.ledger, sender: hostA.address, entryPoint: C.ENTRYPOINT_08, codeOf });
  assert.ok(res.violations.some((v) => /OP-011 TIMESTAMP/.test(v)), "the checker flags TIMESTAMP: " + JSON.stringify(res.violations));
  // NEGATIVE CONTROL 2: a frame that writes another contract's storage must be flagged (USDC approve from the paymaster's view)
  const tr2 = await rpc("debug_traceCall", [{ from: alice.address, to: addr.pm, data: viem.encodeFunctionData({ abi: A.pm.abi, functionName: "fundBudget", args: [appC, 1n] }) }, "latest", { disableStorage: true, enableMemory: false }]);
  const res2 = await check({ logs: tr2.structLogs, entity: addr.pm, sender: hostA.address, entryPoint: C.ENTRYPOINT_08, codeOf });
  assert.ok(res2.violations.some((v) => /STO-031 SSTORE into/.test(v)), "the checker flags a write into another contract: " + JSON.stringify(res2.violations));
});

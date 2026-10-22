// Design B end to end on a LOCAL anvil (chain id 8453, no fork): the LIVE rev-16d ledger and schema-4 registry
// sources, EnclaveLeaseGasReserve + EnclaveLeaseExecutor, two open relays (client/lease-executor-client.mjs
// startLeaseRelay, each with its own funded key), and the shared host adapter (createLeaseSender). Real type-4
// transactions; every number below comes from receipts.
//   - host A registers with ZERO ETH through the repo's existing host paymaster (EntryPoint v0.8 code from
//     fixtures/aa-code-base.json; relay/host-sponsor.mjs + windows/node/sponsor.mjs), which delegates its key to
//     Simple7702Account; its FIRST lease re-delegates the key to the executor, inside the relay's transaction;
//   - claim, renew, STOP (owner deactivates) -> sponsored release (tail refunded), reactivate, MOVE to host B;
//   - a self-hosted rate-0 app (owner's own box policy) and a refused third-party claim;
//   - the same signed lease at two relays: one lands, the other is refused in simulation and costs nothing;
//   - relay economics: what the reserve paid vs what the relay's transaction cost (receipt gasUsed x price);
//   - the raw transactions are saved (fixtures/representative-txs.json) for a read-only Base L1-fee measurement.
// Anvil has no L1 data fee: the reserve's L1 component is OFF here (l1Bps 0) and measured separately.
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
import * as B from "../client/lease-executor-client.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENCLAVE = path.resolve(ROOT, "../enclave");
const OUT = path.join(ROOT, "forge/out");
const { hostSponsor, hostSponsorRouter } = await import(pathToFileURL(path.join(ENCLAVE, "relay/host-sponsor.mjs")).href);
const { sponsoredRegister } = await import(pathToFileURL(path.join(ENCLAVE, "windows/node/sponsor.mjs")).href);
const { linkBytecode } = await import(pathToFileURL(path.join(ENCLAVE, "site/js/lib/contract-linker.js")).href);
const haveAnvil = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const T = { skip: !haveAnvil && "needs anvil", timeout: 300_000 };
const DEV = ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"];
const KEY = { deployer: DEV[0], relay1: DEV[1], relay2: DEV[2], relayBundler: DEV[4] };
const EP = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108", S7702 = "0xe6Cae83BdE06E4c305530e199D7217f42808555B";
const OVERHEAD = { claim: Number(process.env.LEASE_OVERHEAD_CLAIM || 29500), renew: Number(process.env.LEASE_OVERHEAD_RENEW || 24000),
                   release: Number(process.env.LEASE_OVERHEAD_RELEASE || 7000) };
const ZERO32 = `0x${"00".repeat(32)}`;

let anvil, rpcUrl, pc, chain, relays = [], regServer, A = {}, addr = {};
const econ = [], raws = {};
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const rpc = async (method, params) => {
  const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`); return j.result;
};
const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(OUT, file, name + ".json"), "utf8")); return { abi: j.abi, bytecode: j.bytecode.object, links: j.bytecode.linkReferences || {} }; };
const wc = (key) => viem.createWalletClient({ chain, account: privateKeyToAccount(key), transport: viem.http(rpcUrl) });
async function send(key, tx) { const h = await wc(key).sendTransaction({ gas: 8_000_000n, ...tx }); const rc = await pc.waitForTransactionReceipt({ hash: h });
  if (rc.status !== "success") throw new Error("reverted: " + (tx.label || "")); return rc; }
async function deploy(key, a, args = [], libs = {}) { const bytecode = Object.keys(a.links).length ? linkBytecode(a.bytecode, a.links, libs) : a.bytecode;
  return (await send(key, { data: viem.encodeDeployData({ abi: a.abi, bytecode, args }) })).contractAddress; }
const write = (key, address, abi, functionName, args = [], value = 0n) => send(key, { to: address, data: viem.encodeFunctionData({ abi, functionName, args }), value, label: functionName });
const read = (address, abi, functionName, args = []) => pc.readContract({ address, abi, functionName, args });
const row = (id) => read(addr.ledger, A.ledger.abi, "get", [id]);
const reserveOf = async (id, who) => (await read(addr.reserve, A.reserve.abi, "reserveOf", [id, who])).balanceWei;
async function warpTo(ts) { await rpc("evm_setNextBlockTimestamp", [Number(ts)]); await rpc("evm_mine", []); }
const ethOf = (a) => pc.getBalance({ address: a });

/** relay economics of one landed lease: what the reserve paid the relay vs what the relay's transaction cost it */
async function account(label, hash) {
  const rc = await pc.getTransactionReceipt({ hash });
  const tx = await pc.getTransaction({ hash });
  let paid = null;
  for (const l of rc.logs) { try { const ev = viem.decodeEventLog({ abi: A.reserve.abi, data: l.data, topics: l.topics }); if (ev.eventName === "LeaseGasPaid") paid = ev.args; } catch {} }
  const cost = rc.gasUsed * rc.effectiveGasPrice;
  const e = { label, gasUsed: rc.gasUsed, chargedGas: paid.gas, price: rc.effectiveGasPrice, chargedPrice: paid.gasPrice, costWei: cost, paidWei: paid.chargedWei,
              relayNetWei: paid.chargedWei - cost, auth: !!tx.authorizationList?.length, calldataBytes: (tx.input.length - 2) / 2 };
  econ.push(e);
  raws[label] = await rpc("eth_getRawTransactionByHash", [hash]);
  return e;
}
function sender(account_, urls) { return B.createLeaseSender({ client: pc, account: account_, reserve: addr.reserve, relays: urls }); }
function policy(p = {}) {
  return { enabled: true, claimPolicy: 0, sponsorRelease: true, maxClaimsPerEpoch: 4, maxPerOpWei: 10n ** 15n, epochCapWei: 5n * 10n ** 15n,
           epochSec: 3600, renewWindow: 300, minExtension: 600, claimCooldown: 1800, maxGasPrice: 100_000_000n, ...p };
}

before(async () => {
  if (!haveAnvil) return;
  const port = await freePort();
  rpcUrl = `http://127.0.0.1:${port}`;
  chain = viem.defineChain({ id: 8453, name: "local-8453", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  anvil = spawn("anvil", ["--port", String(port), "--chain-id", "8453", "--base-fee", "10000000", "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { await rpc("eth_chainId", []); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  pc = viem.createPublicClient({ chain, transport: viem.http(rpcUrl) });
  const aa = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures/aa-code-base.json"), "utf8"));
  for (const c of Object.values(aa.contracts)) await rpc("anvil_setCode", [c.address, c.code]);
  A = { usdc: art("MockUSDC.sol", "MockUSDC"), feed: art("LeaseGas.t.sol", "MockFeed"), registry: art("EnclaveRegistry.sol", "EnclaveRegistry"),
        lib: art("EnclaveDeployments.sol", "EnclaveLedgerBandwidth"), ledger: art("EnclaveDeployments.sol", "EnclaveDeployments"),
        hostPm: art("EnclaveHostPaymaster.sol", "EnclaveHostPaymaster"), reserve: art("EnclaveLeaseGasReserve.sol", "EnclaveLeaseGasReserve"),
        executor: art("EnclaveLeaseExecutor.sol", "EnclaveLeaseExecutor") };
  addr.usdc = await deploy(KEY.deployer, A.usdc);
  addr.feed = await deploy(KEY.deployer, A.feed);
  await write(KEY.deployer, addr.feed, A.feed.abi, "set", [300000000000n, (await pc.getBlock()).timestamp]);
  addr.registry = await deploy(KEY.deployer, A.registry);
  addr.lib = await deploy(KEY.deployer, A.lib);
  addr.ledger = await deploy(KEY.deployer, A.ledger, [addr.usdc, privateKeyToAccount(generatePrivateKey()).address, addr.registry, addr.feed],
                             { "src/live/EnclaveDeployments.sol:EnclaveLedgerBandwidth": addr.lib });
  const verifierKey = generatePrivateKey();
  addr.hostPm = await deploy(KEY.deployer, A.hostPm, [EP, addr.registry, privateKeyToAccount(verifierKey).address, 10n ** 15n]);
  await write(KEY.deployer, addr.hostPm, A.hostPm.abi, "deposit", [], 10n ** 16n);
  addr.reserve = await deploy(KEY.deployer, A.reserve, [addr.ledger, addr.registry, "0x0000000000000000000000000000000000000000",
    { maxGasPriceCeiling: 10n ** 9n, overheadClaimGas: OVERHEAD.claim, overheadRenewGas: OVERHEAD.renew, overheadReleaseGas: OVERHEAD.release, minClaimInterval: 60, l1Bps: 0 }]);
  addr.executor = await deploy(KEY.deployer, A.executor, [addr.reserve]);
  await write(KEY.deployer, addr.reserve, A.reserve.abi, "bindExecutor", [addr.executor]);
  // two independent relays
  for (const k of [KEY.relay1, KEY.relay2]) relays.push(await B.startLeaseRelay({ client: pc, wallet: wc(k) }));
  // the existing zero-ETH host registration route (the repo's code)
  const hub = new Map();
  const sp = hostSponsor({ hub: { info: (n) => hub.get(n) || null }, endpointOf: (n) => `https://api.enclave.host/t/${n}`, ownerOf: async () => "",
    verifierKey, bundlerKey: KEY.relayBundler, paymaster: addr.hostPm, registry: addr.registry, rpc: rpcUrl, client: pc, wallet: wc(KEY.relayBundler) });
  const route = hostSponsorRouter({ sponsor: sp, json: (res, s, b) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); },
    readBody: (req) => new Promise((r) => { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => r(Buffer.concat(c))); }) });
  regServer = http.createServer((req, res) => route(req, res, new URL(req.url, "http://x")).then((h) => { if (!h) { res.writeHead(404); res.end(); } }));
  await new Promise((ok) => regServer.listen(0, "127.0.0.1", ok));
  addr.regBase = `http://127.0.0.1:${regServer.address().port}`;
  addr.hub = hub;
});
after(async () => {
  for (const r of relays) await r.close();
  regServer?.close();
  if (anvil) anvil.kill("SIGKILL");
  if (Object.keys(raws).length) fs.writeFileSync(path.join(ROOT, "fixtures/representative-txs.json"), JSON.stringify({
    note: "raw signed design-B relay transactions from test/lease-executor-e2e.test.mjs (local anvil, chain id 8453); for a read-only Base L1-fee measurement",
    overheadGas: OVERHEAD, txs: raws, economics: econ.map((e) => Object.fromEntries(Object.entries(e).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]))) }, null, 1) + "\n");
});

async function owner() {
  const key = generatePrivateKey(), a = privateKeyToAccount(key);
  await rpc("anvil_setBalance", [a.address, "0xde0b6b3a7640000"]);   // the OWNER pays its own transactions and deposits
  return { key, address: a.address };
}
async function create(o) {
  const args = ["catalog://app/0", 0, 500, 8080, "", true, "", "0x0000000000000000000000000000000000000000", 0n, 1000n];
  const { result } = await pc.simulateContract({ account: o.address, address: addr.ledger, abi: A.ledger.abi, functionName: "create", args });
  await write(o.key, addr.ledger, A.ledger.abi, "create", args);
  return result;
}
async function fundCompute(o, id, amount6) {
  await write(KEY.deployer, addr.usdc, viem.parseAbi(["function mint(address,uint256)"]), "mint", [o.address, amount6]);
  await write(o.key, addr.usdc, viem.parseAbi(["function approve(address,uint256) returns (bool)"]), "approve", [addr.ledger, amount6]);
  await write(o.key, addr.ledger, A.ledger.abi, "fund", [id, amount6]);
}

let hostA, hostB, hostC, encA, encB, encC, alice, carol, appA, appZ;

test("zero-ETH host: registered through the existing host paymaster, then claim / renew / stop-release / move, all paid by the app's reserve via two relays", T, async () => {
  hostA = privateKeyToAccount(generatePrivateKey());
  const name = "exec-host-a";
  const { privateKey: transportKey, publicKey } = generateKeyPairSync("ed25519");
  addr.hub.set(name, { name, mode: "hv-node", spki: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
                       hvNode: { boot: { ekCertSha256: createHash("sha256").update("ek of " + name).digest("hex") } }, claimant: hostA.address });
  const reg = await sponsoredRegister({ relayBase: addr.regBase, name, transportKey, operator: hostA, client: pc, registry: addr.registry,
    args: { endpoint: `https://api.enclave.host/t/${name}`, repo: "EnclaveHost/enclave", measurement: ZERO32, cpuPricePerSec6: 1000, gpuPricePerSec6: 0,
            proofKey: "0x000000000000000000000000000000000000bEEF" } });
  assert.equal(reg.success, true);
  encA = viem.keccak256(viem.toBytes(`https://api.enclave.host/t/${name}`));
  assert.equal((await pc.getCode({ address: hostA.address })).toLowerCase(), viem.concat(["0xef0100", S7702]).toLowerCase(), "registered and delegated to Simple7702Account");
  assert.equal(await ethOf(hostA.address), 0n);

  alice = await owner();
  appA = await create(alice);
  await fundCompute(alice, appA, 6_000_000n);
  const sA = sender(hostA, ["http://127.0.0.1:1", relays[0].url]);   // a dead relay first: the adapter falls through
  await assert.rejects(sA.claim(appA, encA), (e) => e.code === "Disabled" && /has not enabled/.test(e.message));
  await write(alice.key, addr.reserve, A.reserve.abi, "deposit", [appA], 10n ** 16n);
  await write(alice.key, addr.reserve, A.reserve.abi, "configure", [appA, policy()]);
  const r0 = await reserveOf(appA, alice.address);

  const c = await sA.claim(appA, encA);
  assert.equal((await pc.getCode({ address: hostA.address })).toLowerCase(), viem.concat(["0xef0100", addr.executor]).toLowerCase(), "re-delegated to the executor by its first lease");
  assert.equal((await row(appA)).runnerOperator, hostA.address);
  const ec = await account("claim+auth", c.hash);
  assert.ok(ec.auth, "the authorization rode in the relay's transaction");
  // premature renew: an explicit refusal, nothing sent
  await assert.rejects(sA.renew(appA), (e) => e.code === "NotInRenewWindow");
  await warpTo((await row(appA)).leaseUntil - 200n);
  await account("renew", (await sA.renew(appA)).hash);
  // STOP: the owner deactivates; the host releases with zero ETH; the unused tail goes back to the app
  await write(alice.key, addr.ledger, A.ledger.abi, "setActive", [appA, false]);
  const bal6 = (await row(appA)).balance6;
  await account("release", (await sA.release(appA)).hash);
  assert.equal((await row(appA)).runnerOperator, "0x0000000000000000000000000000000000000000");
  assert.ok((await row(appA)).balance6 > bal6, "tail refunded");
  // MOVE: reactivate; host B claims at once through the OTHER relay (the churn cooldown binds the same host only)
  await write(alice.key, addr.ledger, A.ledger.abi, "setActive", [appA, true]);
  hostB = privateKeyToAccount(generatePrivateKey());
  await rpc("anvil_setBalance", [hostB.address, "0xde0b6b3a7640000"]);   // fixture shortcut: classic registration, then back to 0 ETH
  await pc.waitForTransactionReceipt({ hash: await viem.createWalletClient({ chain, account: hostB, transport: viem.http(rpcUrl) }).sendTransaction({
    to: addr.registry, data: viem.encodeFunctionData({ abi: A.registry.abi, functionName: "register",
      args: ["https://exec-host-b.test", "EnclaveHost/enclave", ZERO32, 1000n, 0n, "0x000000000000000000000000000000000000bEEF"] }) }) });
  await rpc("anvil_setBalance", [hostB.address, "0x0"]);
  encB = viem.keccak256(viem.toBytes("https://exec-host-b.test"));
  await warpTo((await pc.getBlock()).timestamp + 61n);
  await account("claim(move)+auth", (await sender(hostB, [relays[1].url]).claim(appA, encB)).hash);
  assert.equal((await row(appA)).runnerOperator, hostB.address);
  const spent = r0 - await reserveOf(appA, alice.address);
  assert.equal(spent, econ.reduce((a, e) => a + e.paidWei, 0n), "the app's reserve paid exactly the relays' four payments");
  assert.equal(await ethOf(hostA.address) + await ethOf(hostB.address), 0n, "hosts never held ETH");
});

test("self-hosted rate-0 app on its owner's own box: claim/renew paid by the app; a third-party host is refused before any transaction", T, async () => {
  carol = await owner();
  hostC = privateKeyToAccount(generatePrivateKey());
  await rpc("anvil_setBalance", [hostC.address, "0xde0b6b3a7640000"]);
  await pc.waitForTransactionReceipt({ hash: await viem.createWalletClient({ chain, account: hostC, transport: viem.http(rpcUrl) }).sendTransaction({
    to: addr.registry, data: viem.encodeFunctionData({ abi: A.registry.abi, functionName: "register",
      args: ["https://exec-host-c.test", "EnclaveHost/enclave", ZERO32, 1000n, 0n, "0x000000000000000000000000000000000000bEEF"] }) }) });
  await rpc("anvil_setBalance", [hostC.address, "0x0"]);
  encC = viem.keccak256(viem.toBytes("https://exec-host-c.test"));
  appZ = await create(carol);
  await write(carol.key, addr.registry, A.registry.abi, "setPayoutWallet", [encC]);           // carol's own box: rate 0
  await write(carol.key, addr.reserve, A.reserve.abi, "deposit", [appZ], 10n ** 16n);
  await write(carol.key, addr.reserve, A.reserve.abi, "configure", [appZ, policy({ claimPolicy: 1 })]);
  await assert.rejects(sender(hostA, [relays[0].url]).claim(appZ, encA), (e) => e.code === "ClaimantNotAllowed");
  const sC = sender(hostC, [relays[1].url, relays[0].url]);
  await account("claim(rate0)+auth", (await sC.claim(appZ, encC)).hash);
  assert.equal((await row(appZ)).rate, 0n, "compute stays free");
  await warpTo((await row(appZ)).leaseUntil - 100n);
  await account("renew(rate0)", (await sC.renew(appZ)).hash);
  await assert.rejects(sC.renew(appZ), (e) => e.code === "NotInRenewWindow");   // renew spam: refused
  assert.equal(await ethOf(hostC.address), 0n);
});

test("a claim by an already-delegated host carries no authorization (calibration sample)", T, async () => {
  const appP = await create(alice);
  await fundCompute(alice, appP, 6_000_000n);
  await write(alice.key, addr.reserve, A.reserve.abi, "deposit", [appP], 10n ** 16n);
  await write(alice.key, addr.reserve, A.reserve.abi, "configure", [appP, policy()]);
  const r = await sender(hostA, [relays[1].url]).claim(appP, encA);
  const e = await account("claim", r.hash);
  assert.equal(e.auth, false);
});

test("the same signed lease at two relays: one lands, the other is refused in simulation (BadNonce) and costs nobody anything", T, async () => {
  await warpTo((await row(appZ)).leaseUntil - 100n);
  const { executor, lease } = await B.buildLease({ client: pc, reserve: addr.reserve, operator: hostC.address, id: appZ, kind: "renew" });
  const signed = await B.signLease({ client: pc, account: hostC, reserve: addr.reserve, executor, lease });
  const r2before = await ethOf(privateKeyToAccount(KEY.relay2).address);
  const first = await B.submitToRelays({ urls: [relays[0].url], signed });
  assert.equal(first.status, "success");
  await account("renew(race winner)", first.hash);
  await assert.rejects(B.submitToRelays({ urls: [relays[1].url], signed }), (e) => /BadNonce/.test(e.message));
  assert.equal(await ethOf(privateKeyToAccount(KEY.relay2).address), r2before, "the losing relay spent nothing (refused in simulation)");
});

test("relay economics from receipts: payment vs the relay transaction's own cost (L2 only; anvil has no L1 fee)", T, async () => {
  for (const e of econ) {
    const pct = Number(e.relayNetWei * 10000n / e.costWei) / 100;
    console.log(`# ${e.label}: receipt gasUsed ${e.gasUsed}, charged gas ${e.chargedGas}, price ${e.price}/${e.chargedPrice}, cost ${e.costWei} wei,`
      + ` paid ${e.paidWei} wei, relay net ${e.relayNetWei} wei (${pct}%), calldata ${e.calldataBytes} B${e.auth ? ", with 7702 auth" : ""}`);
    assert.equal(e.chargedPrice, e.price, "charged at the transaction's own gas price (under the caps)");
  }
  const noAuth = econ.filter((e) => !e.auth);
  const worst = noAuth.reduce((m, e) => { const a = e.relayNetWei < 0n ? -e.relayNetWei : e.relayNetWei; const p = Number(a * 10000n / e.costWei); return p > m ? p : m; }, 0);
  console.log(`# overhead claim/renew/release ${OVERHEAD.claim}/${OVERHEAD.renew}/${OVERHEAD.release}: worst |relay net| without an authorization ${worst / 100}%`);
});

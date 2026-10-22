// Round 3 (current API): the ACTUAL Linux supervisor candidate - shadow-b/supervisor.js, generated from CURRENT main by
// scripts/rebase-linux-supervisor.py - on the repo's own actual-host rig (work/enclave test/helpers/cli-independent-rig.mjs:
// its ledger, schema-4 registry, management routes and VM-manager fixture). App-funded lease gas through the SHARED
// runtime (network/lease-gas-runtime.mjs, reviewed record by digest, quorum authority, verified landings), with two
// funded relays (client/lease-executor-client.mjs startLeaseRelay, pinned to the reviewed record).
// The only test adaptation is test/helpers/linux-runtime-hook.mjs (loopback RPC/relays, 2 s timeouts, an optional short
// lease deadline); the chain mines a block every 2 s at a 0.01 gwei base fee, as a live chain would.
//   1. zero operator ETH: claim, renew (inside the owner's window) and the owner's release route, all paid by the app's
//      reserve; an app without a reserve is refused in words; the operator key sends nothing;
//   2. restart durability: a sponsored release whose relay answer is lost; the host is killed; the restarted host
//      restores the intent, holds the id, and settles it as RELEASED only from the verified on-chain landing;
//   3. fences are not success: a signed release that never lands is settled "expired" at its deadline and a fresh
//      attempt releases; one whose lease nonce another operation consumed is settled "consumed" and closes "gone";
//   4. a partial configuration refuses every lease write even though the operator could pay;
//   5. NEGATIVE CONTROL: main's unpatched supervisor in the same world pays its own claims.
// Run: node --test test/supervisor-current-runtime.test.mjs   (cwd work/app-lease-gas)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as viem from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import * as B from "../client/lease-executor-client.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENCLAVE = path.resolve(ROOT, "../enclave");
const RIG = await import(pathToFileURL(path.join(ENCLAVE, "test/helpers/cli-independent-rig.mjs")).href);
const MR = await import(pathToFileURL(path.join(ENCLAVE, "test/helpers/move-release-rig.mjs")).href);
const SUPERVISOR = path.join(ROOT, "shadow-b/supervisor.js");
const HOOK = path.join(ROOT, "test/helpers/linux-runtime-hook.mjs");
const FAULT = path.join(ROOT, "test/helpers/fs-fault-hook.mjs");
const skip = RIG.haveTools();
const T = skip ? { skip, timeout: 480_000 } : { timeout: 480_000 };
const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(ROOT, "forge/out", file, name + ".json"), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences || {} }; };
const cleanups = [];
after(async () => { while (cleanups.length) { try { await cleanups.pop()(); } catch {} } });
// per-test scope: each test's world (anvil, relays, hosts) is torn down when THAT test ends, not at file end (one world
// at a time keeps the run inside its memory allocation)
let cur = cleanups;
const begin = (t) => { const mine = []; cur = mine; t.after(async () => { while (mine.length) { try { await mine.pop()(); } catch {} } cur = cleanups; }); };
const track = (f) => cur.push(f);
const OPERATOR = privateKeyToAccount(RIG.KEYS.operator).address;
const ZERO40 = /^0x0{40}$/i;

async function world({ apps = 1, leaseSec = 120n, minClaimInterval = 60, claimCooldown = 120 } = {}) {
  const r = await RIG.startRig();
  track(() => r.stop());
  // a block every 2 s at 0.01 gwei (the rig's anvil only mines on transactions, at a zero base fee). NOTE the fee is a
  // sawtooth: blocks mined by transactions between two ticks decay it (EIP-1559, 12.5% per near-empty block), each tick
  // resets it - so a lease signed at a decayed fee (its maximum: 2x that fee) can be refused as OverSignedMax when it is
  // forwarded after a tick. That was the intermittent "held release landing" timeout (batch5 test 2, domain1 test 10:
  // forwarded 422 OverSignedMax, charge 1385859420000 > signed 360000000000); see forwardHeld().
  const fees = { paused: false };
  const mine = setInterval(() => { if (!fees.paused) r.rpcCall("anvil_setNextBlockBaseFeePerGas", ["0x989680"]).then(() => r.rpcCall("evm_mine", [])).catch(() => {}); }, 2000);
  track(() => clearInterval(mine));
  const dep = r.wc(RIG.KEYS.deployer), owner = r.wc(RIG.KEYS.owner);
  const L = r.addresses.ledger;
  await r.write(dep, L, r.A.ledger.abi, "setLeaseSec", [leaseSec]);
  const A = { reserve: art("EnclaveLeaseGasReserve.sol", "EnclaveLeaseGasReserve"), executor: art("EnclaveLeaseExecutor.sol", "EnclaveLeaseExecutor") };
  const reserve = await r.deploy(A.reserve, [L, r.addresses.registry, "0x0000000000000000000000000000000000000000",
    { maxGasPriceCeiling: 10n ** 9n, overheadClaimGas: 29_500, overheadRenewGas: 24_000, overheadReleaseGas: 7_000, minClaimInterval, l1Bps: 0 }]);
  const executor = await r.deploy(A.executor, [reserve]);
  await r.write(dep, reserve, A.reserve.abi, "bindExecutor", [executor]);
  const deployment = { chainId: 8453, reserve, executor, ledger: L, registry: r.addresses.registry,
    reserveCodeHash: viem.keccak256(await r.pc.getCode({ address: reserve })), executorCodeHash: viem.keccak256(await r.pc.getCode({ address: executor })) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lease-sup-current-"));
  track(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bytes = Buffer.from(JSON.stringify({ format: "enclave-lease-gas-deployment/v1", ...deployment }));
  const recordFile = path.join(dir, "lease-gas-record.json");
  fs.writeFileSync(recordFile, bytes);
  const digest = "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
  // the owner declares the rig's host as its own box (registry setPayoutWallet: msg.sender) -> rate 0, self-hosted
  await r.write(owner, r.addresses.registry, r.A.registry4.abi, "setPayoutWallet", [r.runner]);
  const appRef = await MR.servableAppRef(r);
  const create = async () => r.createdId(await r.write(owner, L, r.A.ledger.abi, "create",
    [appRef, 0, 100, 3000, "http:3000", true, "", "0x0000000000000000000000000000000000000000", 0n, 100000n]));
  const val = async (to, abi, fn, args, value) => r.pc.waitForTransactionReceipt({ hash: await owner.writeContract({ address: to, abi, functionName: fn, args, value }) });
  const paid = [];
  for (let i = 0; i < apps; i++) {
    const id = await create();
    await val(reserve, A.reserve.abi, "deposit", [id], 10n ** 16n);
    await r.write(owner, reserve, A.reserve.abi, "configure", [id, { enabled: true, claimPolicy: 1, sponsorRelease: true, maxClaimsPerEpoch: 4,
      maxPerOpWei: 10n ** 15n, epochCapWei: 5n * 10n ** 15n, epochSec: 3600, renewWindow: 50, minExtension: 60, claimCooldown, maxGasPrice: 10n ** 8n }]);
    paid.push(id);
  }
  const unpaid = await create();
  const relays = [];
  for (let i = 0; i < 2; i++) {
    const k = generatePrivateKey();
    await r.rpcCall("anvil_setBalance", [privateKeyToAccount(k).address, "0xde0b6b3a7640000"]);
    relays.push(await B.startLeaseRelay({ client: r.pc, wallet: viem.createWalletClient({ chain: RIG.chain, account: privateKeyToAccount(k), transport: viem.http(r.rpc) }),
      deployment, allowLoopbackHttp: true }));
  }
  track(async () => { for (const x of relays) await x.close(); });
  const env = (relayUrls, extra = {}) => ({ ENCLAVE_LEASE_GAS_FILE: recordFile, ENCLAVE_LEASE_GAS_DIGEST: digest, ENCLAVE_LEASE_GAS_RPCS: r.rpc,
    ENCLAVE_LEASE_GAS_RELAYS: relayUrls.join(","), NODE_OPTIONS: `--import ${HOOK}`, RENEW_MARGIN_SEC: "600", RELEASE_POLL_MS: "1000", RELEASE_RETRY_SEC: "2", ...extra });
  return { r, A, L, reserve, executor, deployment, owner, paid, unpaid, relays, env, dir, fees };
}
const zeroOperator = (r) => r.rpcCall("anvil_setBalance", [OPERATOR, "0x0"]);
/** The supervisor's boot (re-)registration publishes its freshly minted proof key: an operator-paid REGISTRY write, out of
 *  this feature's scope (claim/renew/release only). Let it land, then take every wei away: from here on the lease
 *  operations must work with zero operator ETH. */
async function registeredThenZero(w, h) {
  await h.waitLog(/\[registry\] registered https:/, 60000);
  await zeroOperator(w.r);
  return w.r.pc.getBlockNumber({ cacheTime: 0 });
}
async function operatorTxs(r, L, fromBlock) {
  const head = await r.pc.getBlockNumber({ cacheTime: 0 });
  let ownLedgerTxs = 0, opTxs = 0;
  for (let n = fromBlock; n <= head; n++) {
    const blk = await r.pc.getBlock({ blockNumber: n, includeTransactions: true });
    for (const tx of blk.transactions) {
      if (viem.getAddress(tx.from) !== OPERATOR) continue;
      opTxs++;
      if (tx.to && viem.getAddress(tx.to) === viem.getAddress(L)) ownLedgerTxs++;
    }
  }
  return { opTxs, ownLedgerTxs };
}
const paidKinds = async (w, id, fromBlock) => (await w.r.pc.getContractEvents({ address: w.reserve, abi: w.A.reserve.abi, eventName: "LeaseGasPaid", fromBlock }))
  .filter((e) => e.args.id === id).map((e) => ["", "claim", "renew", "release"][e.args.kind]);
const stateOf = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };
async function until(f, ms, what) {
  const t0 = Date.now();
  for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`); await new Promise((ok) => setTimeout(ok, 500)); }
}
/** A relay front that passes claims/renews to `upstream` but HOLDS every release: it never answers (the host times
 *  out: a lost answer), and forwards the held body only when open() is called with forward = true. */
async function holdingRelay(upstream, { forward }) {
  const held = [], forwarded = []; let release; const opened = new Promise((ok) => (release = ok));
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const pass = async () => { const x = await fetch(upstream + req.url, req.method === "POST" ? { method: "POST", headers: { "content-type": "application/json" }, body } : {});
      res.writeHead(x.status, { "content-type": "application/json" }); res.end(await x.text()); };
    if (req.method !== "POST") return pass();
    let kind = 0; try { kind = Number(JSON.parse(body.toString()).lease.kind); } catch {}
    if (kind !== 3) return pass();
    held.push(body);
    opened.then(() => { if (!forward) return; const t0 = Date.now();
      return fetch(upstream + req.url, { method: "POST", headers: { "content-type": "application/json" }, body })
        .then(async (x) => forwarded.push(`${x.status} after ${Date.now() - t0} ms: ${(await x.text()).slice(0, 300)}`))
        .catch((e) => forwarded.push(`error after ${Date.now() - t0} ms: ${e.message}`)); });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  track(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, held, forwarded, open: () => release() };
}
/** Forward the releases a front holds at the fee FLOOR: the tick pauses and one block is mined at a zero base fee, so the
 *  relay's anchor fee (0 + its priority) is within every maximum a host signed (2x an anchor fee >= that priority). The
 *  subject of these tests is settlement after a restart/rotation, not fee volatility: a fee risen past the signed maximum
 *  is refused by the relay (OverSignedMax) and the release stays held until its deadline. The tick resumes as soon as the
 *  relay has answered every forwarded release (landed or refused: front.forwarded keeps the answers), or after 60 s. */
async function forwardHeld(w, front) {
  w.fees.paused = true;
  track(() => { w.fees.paused = false; });
  await w.r.rpcCall("anvil_setNextBlockBaseFeePerGas", ["0x0"]); await w.r.rpcCall("evm_mine", []);
  { const b = await w.r.pc.getBlock(), ct = Number(b.timestamp); console.log(`# forward at chain ${ct}, wall ${Math.floor(Date.now() / 1000)} (skew ${ct - Math.floor(Date.now() / 1000)} s), base fee ${b.baseFeePerGas}`); }
  front.open();
  until(() => front.forwarded.length >= front.held.length, 60000, "the relay's answers").catch(() => {}).finally(() => { w.fees.paused = false; });
}
/** A pass-through relay front that counts every POST /v1/lease by lease kind (1 claim, 2 renew, 3 release). */
async function countingRelay(upstream) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (req.method === "POST") { let kind = 0; try { kind = Number(JSON.parse(body.toString()).lease.kind); } catch {} seen.push(kind); }
    const x = await fetch(upstream + req.url, req.method === "POST" ? { method: "POST", headers: { "content-type": "application/json" }, body } : {});
    res.writeHead(x.status, { "content-type": "application/json" }); res.end(await x.text());
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  track(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, posts: (kind) => seen.filter((k) => k === kind).length, total: () => seen.length };
}
const releaseEvents = async (w, id, fromBlock) => (await paidKinds(w, id, fromBlock)).filter((k) => k === "release");
const LEDGER_EVENTS = (w, fromBlock) => w.r.pc.getContractEvents({ address: w.L, abi: w.r.A.ledger.abi, fromBlock, toBlock: "latest" });
const startHost = (w, env, extra = {}) => {
  const dir = fs.mkdtempSync(path.join(w.dir, "host-"));
  return RIG.startActualHost(w.r, { id: w.paid[0], owner: w.owner.account.address, dir, token: "7c".repeat(32), claim: true, seed: false, script: SUPERVISOR, env, ...extra })
    .then((h) => { track(() => h.kill()); return h; });
};

test("1. zero operator ETH: the actual supervisor claims, renews in the owner's window and releases through the app's reserve", T, async (t) => {
  begin(t);
  const w = await world();
  const [id] = w.paid;
  const fromBlock = await w.r.pc.getBlockNumber({ cacheTime: 0 });
  const b0 = (await w.r.pc.readContract({ address: w.reserve, abi: w.A.reserve.abi, functionName: "reserveOf", args: [id, w.owner.account.address] })).balanceWei;
  const h = await startHost(w, w.env([`http://127.0.0.1:1`, w.relays[0].url, w.relays[1].url]));
  const zeroBlock = await registeredThenZero(w, h);
  await h.waitLog(/\[fixture\] lease-gas runtime import redirected/, 30000);
  await h.waitLog(/\[lease-gas\] app-funded leases ON: reserve 0x[0-9a-fA-F]{40}, 3 relay\(s\), 1 RPC\(s\) \(quorum 1\)/, 30000);
  await h.waitLog(new RegExp(`\\[lease-gas\\] claim ${id} landed in 0x[0-9a-f]{64} via http://127\\.0\\.0\\.1:\\d+; the app's reserve paid \\d+ wei`), 120000);
  await h.waitLog(new RegExp(`\\[claim\\] ${id} adopted`), 120000);
  const row1 = await MR.getRow(w.r, id);
  assert.equal(row1.runnerOperator, OPERATOR); assert.equal(row1.rate, 0n, "self-hosted rate 0 stays rate 0");
  assert.equal((await w.r.pc.getCode({ address: OPERATOR })).toLowerCase(), B.designator(w.executor), "delegated by its first lease");
  await h.waitLog(new RegExp(`\\[lease-gas\\] app-funded claim of ${w.unpaid} not sent: claim ${w.unpaid} refused: the app's owner has not enabled a lease-gas reserve`), 120000);
  assert.match((await MR.getRow(w.r, w.unpaid)).runner, /^0x0{64}$/, "never claimed with the host's ETH");
  // the renewal waits for the owner's 50 s window (renew lead 35 s), not the host's 600 s margin
  const from2 = h.stdout().length;
  await h.waitLog(new RegExp(`\\[lease-gas\\] renew ${id} landed in`), 240000, from2);
  await h.waitLog(new RegExp(`\\[claim\\] ${id} lease renewed`), 60000, from2);
  const renewedAt = Number((await w.r.pc.getBlock()).timestamp);
  assert.ok(Number(row1.leaseUntil) - renewedAt <= 50, `renewed inside the owner's window (${Number(row1.leaseUntil) - renewedAt}s before the end)`);
  assert.ok((await MR.getRow(w.r, id)).leaseUntil > row1.leaseUntil);
  // the owner's release route: the durable intent, sponsored
  const tok = await MR.login(h);
  const x = await MR.api(h, "POST", `/v1/deployments/${id}/release`, tok);
  assert.equal(x.status, 200, JSON.stringify(x.json));
  assert.equal(x.json.released, true, JSON.stringify(x.json));
  assert.match(h.stdout(), new RegExp(`\\[release\\] ${id} sponsored release 1/4 lease nonce \\d+ \\(.*landed 0x[0-9a-f]{64}.*\\); the app's reserve pays, never this host`));
  assert.match((await MR.getRow(w.r, id)).runnerOperator, ZERO40, "released");
  assert.equal((stateOf(h.stateFile).releaseIntents || []).length, 0, "no open intent left");
  assert.equal((await operatorTxs(w.r, w.L, fromBlock)).ownLedgerTxs, 0, "no ledger transaction from the operator key, ever");
  const { opTxs } = await operatorTxs(w.r, w.L, zeroBlock + 1n);
  assert.equal(opTxs, 0, "after its one-time registration the operator key sent no transaction at all");
  assert.equal(await w.r.pc.getBalance({ address: OPERATOR }), 0n);
  const kinds = await paidKinds(w, id, fromBlock);
  assert.deepEqual([...new Set(kinds)].sort(), ["claim", "release", "renew"]);
  const b1 = (await w.r.pc.readContract({ address: w.reserve, abi: w.A.reserve.abi, functionName: "reserveOf", args: [id, w.owner.account.address] })).balanceWei;
  const events = (await w.r.pc.getContractEvents({ address: w.reserve, abi: w.A.reserve.abi, eventName: "LeaseGasPaid", fromBlock })).filter((e) => e.args.id === id);
  assert.equal(b0 - b1, events.reduce((a, e) => a + e.args.chargedWei, 0n), "the reserve paid exactly the relays");
  console.log(`# linux current: reserve paid ${kinds.join(", ")} (${b0 - b1} wei) for ${id}; operator transactions ${opTxs}, operator ETH 0`);
});

test("2. restart durability: a release whose relay answer is lost; the restarted host settles it only from the verified landing", T, async (t) => {
  begin(t);
  const w = await world();
  const [id] = w.paid;
  const fromBlock = await w.r.pc.getBlockNumber({ cacheTime: 0 });
  const front = await holdingRelay(w.relays[0].url, { forward: true });
  const h1 = await startHost(w, w.env([front.url]));
  const zeroBlock = await registeredThenZero(w, h1);
  await h1.waitLog(new RegExp(`\\[claim\\] ${id} adopted`), 120000);
  const tok = await MR.login(h1);
  MR.api(h1, "POST", `/v1/deployments/${id}/release`, tok).catch(() => {});   // the route never answers: the host is killed
  const it = await until(() => (stateOf(h1.stateFile).releaseIntents || []).find((i) => i.id === id && i.txs.some((t) => t.sponsored && t.intents?.length)), 60000, "a persisted signed intent");
  await until(() => front.held.length > 0, 30000, "the relay holding the release");
  const tx = it.txs.find((t) => t.sponsored);
  assert.equal(tx.state, "pending"); assert.ok(tx.intents[0].deadline && tx.intents[0].payee && tx.intents[0].maxChargeWei && tx.intents[0].fromBlock);
  assert.equal(tx.intents[0].enclaveId, "0x" + "00".repeat(32));
  await until(() => /sponsored release 1\/4 lease nonce \d+ \(.*pending/.test(h1.stdout()), 30000, "the attempt left pending");
  h1.kill();
  assert.equal((await MR.getRow(w.r, id)).runnerOperator, OPERATOR, "nothing landed yet");
  await forwardHeld(w, front);                             // the relay sends the lease the dead host signed
  await until(async () => ZERO40.test((await MR.getRow(w.r, id)).runnerOperator), 60000, "the held release landing")
    .catch(async (e) => {
      const leases = front.held.map((b) => { try { const l = JSON.parse(b.toString()).lease; return { kind: l.kind, nonce: l.nonce, deadline: l.deadline, payee: l.payee }; } catch { return null; } });
      const chainNow = Number((await w.r.pc.getBlock()).timestamp), row = await MR.getRow(w.r, id);
      throw new Error(`${e.message}; held leases ${JSON.stringify(leases)}; chain time ${chainNow} (wall ${Math.floor(Date.now() / 1000)}); `
        + `runner operator ${row.runnerOperator}; the relay answered the forwarded lease: ${JSON.stringify(front.forwarded)}`);
    });
  console.log(`# test 2: the relay answered the forwarded release: ${JSON.stringify(front.forwarded)}`);
  const h2 = await startHost(w, w.env([w.relays[1].url]), { stateFile: h1.stateFile });
  await h2.waitLog(/\[release\] restored 1 unresolved release\(s\)/, 30000);
  await h2.waitLog(new RegExp(`\\[release\\] ${id} released \\(`), 120000);
  assert.doesNotMatch(h2.stdout(), new RegExp(`sponsored release 2/4`), "settled from the chain, not re-sent");
  assert.deepEqual((await paidKinds(w, id, fromBlock)).filter((k) => k === "release"), ["release"], "exactly one release paid");
  assert.equal((await operatorTxs(w.r, w.L, fromBlock)).ownLedgerTxs, 0);
  assert.equal((await operatorTxs(w.r, w.L, zeroBlock + 1n)).opTxs, 0, "zero-ETH key: nothing sent after registration (the restarted host's re-registration cannot pay: the documented proof-key gap)");
});

test("3. fences are not success: an expired signed release is re-sent and releases; a consumed lease nonce closes 'gone'", T, async (t) => {
  begin(t);
  const w = await world({ apps: 2 });
  const [a, b] = w.paid;
  const fromBlock = await w.r.pc.getBlockNumber({ cacheTime: 0 });
  const front = await holdingRelay(w.relays[0].url, { forward: false });
  const h1 = await startHost(w, w.env([front.url], { TEST_LEASE_FIXTURE_TTL_SEC: "30" }));
  const zeroBlock = await registeredThenZero(w, h1);
  await h1.waitLog(new RegExp(`\\[claim\\] ${a} adopted`), 120000);
  await h1.waitLog(new RegExp(`\\[claim\\] ${b} adopted`), 120000);
  const tok = await MR.login(h1);
  for (const id of [a, b]) MR.api(h1, "POST", `/v1/deployments/${id}/release`, tok).catch(() => {});
  await until(() => [a, b].every((id) => new RegExp(`\\[release\\] ${id} sponsored release 1/4 lease nonce \\d+ \\(.*pending`).test(h1.stdout())), 90000, "both attempts pending");
  h1.kill();
  // another operation of THIS operator consumes b's lease nonce (a release the test signs with the fixture key)
  const op = B.createLeaseClient({ client: w.r.pc, clients: [w.r.pc], account: privateKeyToAccount(RIG.KEYS.operator), reserve: w.reserve, deployment: w.deployment,
    relays: [w.relays[1].url], allowLoopbackHttp: true, confirmations: 0, requestTimeoutMs: 5000 });
  await op.release(b);
  assert.match((await MR.getRow(w.r, b)).runnerOperator, ZERO40);
  const h2 = await startHost(w, w.env([w.relays[1].url]), { stateFile: h1.stateFile });
  await h2.waitLog(/\[release\] restored 2 unresolved release\(s\)/, 30000);
  await h2.waitLog(new RegExp(`\\[release\\] ${b} gone \\(`), 120000);
  await h2.waitLog(new RegExp(`\\[release\\] ${a} sponsored release 2/4 lease nonce \\d+ \\(.*landed`), 180000);
  await h2.waitLog(new RegExp(`\\[release\\] ${a} released \\(`), 120000);
  const out = h1.stdout() + h2.stdout();
  assert.doesNotMatch(out, new RegExp(`\\[release\\] ${b} released`), "a consumed nonce is never this release's success");
  const st = stateOf(h2.stateFile);
  assert.equal((st.releaseIntents || []).length, 0);
  assert.deepEqual((await paidKinds(w, a, fromBlock)).filter((k) => k === "release"), ["release"], "a: one release, the second attempt");
  assert.deepEqual((await paidKinds(w, b, fromBlock)).filter((k) => k === "release"), ["release"], "b: only the other operation's");
  assert.ok(front.held.length >= 2, "the first attempts were signed and held, never landed");
  assert.equal((await operatorTxs(w.r, w.L, fromBlock)).ownLedgerTxs, 0);
  assert.equal((await operatorTxs(w.r, w.L, zeroBlock + 1n)).opTxs, 0);
  console.log(`# fences: ${a} expired then released on attempt 2; ${b} consumed by another operation -> gone`);
});

test("4. a partial configuration refuses every lease write even though the operator could pay", T, async (t) => {
  begin(t);
  const w = await world();
  const [id] = w.paid;
  const fromBlock = await w.r.pc.getBlockNumber({ cacheTime: 0 });
  const env = w.env([w.relays[0].url]);
  delete env.ENCLAVE_LEASE_GAS_DIGEST;
  const h = await startHost(w, env);
  await h.waitLog(/\[registry\] registered https:/, 60000);   // its boot registration is the operator's own (out of scope)
  await new Promise((ok) => setTimeout(ok, 3000));
  const bal = await w.r.pc.getBalance({ address: OPERATOR });
  await h.waitLog(/\[lease-gas\] app-funded leases are configured but cannot be loaded now \(.*DIGEST/, 30000);
  await h.waitLog(new RegExp(`\\[lease-gas\\] app-funded claim of ${id} not sent: .*DIGEST.*; this host's ETH is never used instead`), 60000);
  const n = h.stdout().length;
  await h.waitLog(new RegExp(`\\[lease-gas\\] app-funded claim of ${id} not sent`), 60000, n);   // and again: still refusing
  assert.match((await MR.getRow(w.r, id)).runner, /^0x0{64}$/);
  assert.equal((await operatorTxs(w.r, w.L, fromBlock)).ownLedgerTxs, 0);
  assert.equal(await w.r.pc.getBalance({ address: OPERATOR }), bal, "not one wei of the operator's ETH after its registration");
});

test("5. NEGATIVE CONTROL: main's unpatched supervisor in the same world pays its own claims; the reserve is never used", T, async (t) => {
  begin(t);
  const w = await world();
  const [id] = w.paid;
  const fromBlock = await w.r.pc.getBlockNumber({ cacheTime: 0 });
  const b0 = (await w.r.pc.readContract({ address: w.reserve, abi: w.A.reserve.abi, functionName: "reserveOf", args: [id, w.owner.account.address] })).balanceWei;
  const env = w.env([w.relays[0].url]); delete env.NODE_OPTIONS;
  // main's UNPATCHED supervisor, frozen before any Linux integration (control-linux/supervisor.js = main b0ef78f6)
  const h = await startHost(w, env, { script: path.join(ROOT, "control-linux/supervisor.js") });
  await h.waitLog(new RegExp(`\\[claim\\] ${id} adopted`), 120000);
  const { ownLedgerTxs } = await operatorTxs(w.r, w.L, fromBlock);
  assert.ok(ownLedgerTxs >= 1, `the operator key paid its own claim (${ownLedgerTxs})`);
  assert.equal((await w.r.pc.readContract({ address: w.reserve, abi: w.A.reserve.abi, functionName: "reserveOf", args: [id, w.owner.account.address] })).balanceWei, b0);
  assert.doesNotMatch(h.stdout(), /\[lease-gas\]/);
});

test("6. strict journal: a write / fsync / rename / directory-fsync failure sends NO release lease to any relay; a restart keeps the hold, then releases", T, async (t) => {
  begin(t);
  // four apps, one fault mode each; a 600 s lease so none is "lapsing" (< 60 s left) when the restart resolves it
  const w = await world({ apps: 4, leaseSec: 600n });
  const ctl = path.join(w.dir, "fault.json"), audit = path.join(w.dir, "audit.jsonl"); fs.writeFileSync(ctl, "{}");
  const front = await countingRelay(w.relays[0].url);
  const fromBlock = await w.r.pc.getBlockNumber({ cacheTime: 0 });
  const h1 = await startHost(w, w.env([front.url], { NODE_OPTIONS: `--import ${HOOK} --import ${FAULT}`, TEST_FS_FAULT_CTL: ctl, TEST_FS_AUDIT: audit }));
  await h1.waitLog(/\[fixture\] state-write fault injector armed/, 30000);
  const zeroBlock = await registeredThenZero(w, h1);
  for (const id of w.paid) await h1.waitLog(new RegExp(`\\[claim\\] ${id} adopted`), 240000);
  const tok = await MR.login(h1);
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const strictTmp = esc(h1.stateFile + ".strict.tmp"), dir = esc(path.dirname(h1.stateFile));
  // "when: sponsored": only a save that carries a sponsored attempt fails, so the open intent itself reaches disk
  const modes = [["write", `write failure, ${strictTmp}`], ["fsync-file", `fsync failure, ${strictTmp}`], ["rename", `rename failure, ${strictTmp}`],
    ["fsync-dir", `fsync failure, ${dir}\\)`]];
  for (let i = 0; i < modes.length; i++) {
    fs.writeFileSync(ctl, JSON.stringify({ id: `m${i}`, op: modes[i][0], when: "sponsored" }));
    const n = h1.stdout().length;
    MR.api(h1, "POST", `/v1/deployments/${w.paid[i]}/release`, tok).catch(() => {});
    await h1.waitLog(new RegExp(`\\[release\\] ${w.paid[i]} sponsored release NOT started: the attempt could not be made durable \\(EIO: injected ${modes[i][1]}`), 90000, n);
  }
  await new Promise((ok) => setTimeout(ok, 5000));   // more resolver passes, all still under a fault
  assert.equal(front.posts(3), 0, "not one release lease reached a relay");
  for (const id of w.paid) {
    assert.equal((await MR.getRow(w.r, id)).runnerOperator, OPERATOR, "every lease is still held");
    assert.deepEqual(await releaseEvents(w, id, fromBlock), []);
  }
  const st = stateOf(h1.stateFile);   // the intents themselves were saved durably: the hold survives a restart
  assert.deepEqual(new Set((st.releaseIntents || []).map((x) => x.id)), new Set(w.paid));
  assert.ok(st.releaseIntents.every((x) => x.txs.every((tx) => !tx.sponsored || tx.intents.length === 0)), "no signed lease was ever recorded as sent");
  const lines = fs.readFileSync(audit, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.length > 0 && lines.every((x) => x.fsynced), "every replacement of the state file was fsynced first");
  h1.kill();
  fs.writeFileSync(ctl, "{}");
  const h2 = await startHost(w, w.env([front.url]), { stateFile: h1.stateFile });
  await h2.waitLog(/\[release\] restored 4 unresolved release\(s\)/, 30000);
  for (const id of w.paid) await h2.waitLog(new RegExp(`\\[release\\] ${id} released \\(`), 240000);
  for (const id of w.paid) assert.deepEqual(await releaseEvents(w, id, fromBlock), ["release"], `${id}: exactly one release, after the restart`);
  assert.equal(front.posts(3), 4);
  assert.equal((await operatorTxs(w.r, w.L, zeroBlock + 1n)).opTxs, 0);
});

test("7. a corrupt or malformed release journal fails closed: no resume, claim, renew or release send, and the file is never overwritten", T, async (t) => {
  begin(t);
  const w = await world();
  const [id] = w.paid;
  const front = await countingRelay(w.relays[0].url);
  const h1 = await startHost(w, w.env([front.url]));
  await registeredThenZero(w, h1);
  await h1.waitLog(new RegExp(`\\[claim\\] ${id} adopted`), 120000);
  const leased = await MR.getRow(w.r, id);
  h1.kill();
  const cases = [
    ["unreadable", '{"savedAt": 1, "deployments": [ {"id": "trunc', /\[state\] .*: unreadable \(/],
    ["malformed", JSON.stringify({ savedAt: Date.now(), deployments: [], releaseIntents: [{ id, txs: [{ sponsored: true, state: "pending" }] }] }),
      /\[state\] .*: the release journal is malformed: .*a sponsored attempt without its signed leases/],
  ];
  for (const [label, bytes, line] of cases) {
    fs.writeFileSync(h1.stateFile, bytes);
    const posts = front.total(), from = await w.r.pc.getBlockNumber({ cacheTime: 0 });
    const h = await startHost(w, w.env([front.url]), { stateFile: h1.stateFile });
    await h.waitLog(line, 30000);
    // past the owner's renew window AND past the lease's end: nothing resumed, renewed, re-claimed or released
    const end = Number(leased.leaseUntil) + 5;
    await until(async () => Number((await w.r.pc.getBlock()).timestamp) > end || label === "malformed", 200000, "the lease's end");
    if (label === "malformed") await new Promise((ok) => setTimeout(ok, 15000));
    assert.equal(front.total(), posts, `${label}: no lease of any kind reached a relay`);
    assert.deepEqual((await LEDGER_EVENTS(w, from + 1n)).filter((l) => ["Claimed", "Renewed", "Released"].includes(l.eventName)), []);
    const row = await MR.getRow(w.r, id);
    assert.equal(row.leaseUntil, leased.leaseUntil, `${label}: not renewed`);
    assert.doesNotMatch(h.stdout(), new RegExp(`\\[claim\\] ${id} (adopted|resuming|lease renewed|lease RE-CLAIMED)`));
    assert.equal(fs.readFileSync(h1.stateFile, "utf8"), bytes, `${label}: the journal file was never overwritten`);
    h.kill();
  }
});

test("8. scheduler: with 120 s leases and the owner's 50 s window, renewal urgency comes from the app's own window - all four apps are adopted", T, async (t) => {
  begin(t);
  // main's rule (any running lease inside HALF the 600 s margin blocks new adoptions) holds a 120 s lease ALWAYS
  // "pressed": a 4th app was never adopted (root review of batch2). A sponsored renew cannot start before the owner's
  // window, so the candidate measures urgency against that window instead.
  const w = await world({ apps: 4 });
  const h = await startHost(w, w.env([w.relays[0].url]));
  await registeredThenZero(w, h);
  for (const id of w.paid) await h.waitLog(new RegExp(`\\[claim\\] ${id} adopted`), 240000);
  for (const id of w.paid) assert.equal((await MR.getRow(w.r, id)).runnerOperator, OPERATOR);
  // and renewals still happen inside the window for all of them
  const n = h.stdout().length;
  for (const id of w.paid) await h.waitLog(new RegExp(`\\[claim\\] ${id} lease renewed`), 240000, n);
});

test("9. every replacement of the state file is durable: accounting saves after a pending signed release, short writes, zero progress", T, async (t) => {
  begin(t);
  const w = await world({ apps: 2, leaseSec: 600n });
  const [a, b] = w.paid;
  const ctl = path.join(w.dir, "fault.json"), audit = path.join(w.dir, "audit.jsonl"); fs.writeFileSync(ctl, "{}");
  const front = await holdingRelay(w.relays[0].url, { forward: false });   // releases are held: they stay pending
  const h = await startHost(w, w.env([front.url], { NODE_OPTIONS: `--import ${HOOK} --import ${FAULT}`, TEST_FS_FAULT_CTL: ctl, TEST_FS_AUDIT: audit }));
  await registeredThenZero(w, h);
  for (const id of w.paid) await h.waitLog(new RegExp(`\\[claim\\] ${id} adopted`), 240000);
  const tok = await MR.login(h);
  // (1) every write is SHORT (7 bytes a call): the writer loops; a's signed lease is persisted complete and valid
  fs.writeFileSync(ctl, JSON.stringify({ id: "short", op: "short-write" }));
  MR.api(h, "POST", `/v1/deployments/${a}/release`, tok).catch(() => {});
  await h.waitLog(new RegExp(`\\[release\\] ${a} sponsored release 1/4 lease nonce \\d+ \\(.*pending`), 90000);
  let st = stateOf(h.stateFile);
  const pending = (st.releaseIntents || []).find((x) => x.id === a)?.txs.find((x) => x.sponsored);
  assert.ok(pending && pending.intents.length >= 1 && pending.intents[0].deadline, "the signed lease is on disk, complete, as valid JSON");
  assert.equal(front.held.length, 1);
  // (2) an ordinary checkpoint AFTER that signed lease, with every file fsync failing: b's release begins with an
  // ordinary save (beginRelease), then its attempt's strict save. Neither may replace the durable journal with an
  // unsynced file (the old writer renamed an unsynced file over it), and b's attempt is refused before any signature.
  fs.writeFileSync(ctl, JSON.stringify({ id: "acct", op: "fsync-file" }));
  const before = fs.readFileSync(h.stateFile, "utf8");
  let n = h.stdout().length;
  MR.api(h, "POST", `/v1/deployments/${b}/release`, tok).catch(() => {});
  await h.waitLog(/\[state\] save failed: EIO: injected fsync failure/, 60000, n);
  await h.waitLog(new RegExp(`\\[release\\] ${b} sponsored release NOT started: the attempt could not be made durable \\(EIO: injected fsync failure`), 90000, n);
  assert.equal(fs.readFileSync(h.stateFile, "utf8"), before, "the durable journal was not replaced by an unsynced checkpoint");
  // (3) zero progress (only saves that carry a sponsored attempt): b's retried attempt is refused, nothing signed or sent
  fs.writeFileSync(ctl, JSON.stringify({ id: "zero", op: "zero-write", when: "sponsored" }));
  n = h.stdout().length;
  await h.waitLog(new RegExp(`\\[release\\] ${b} sponsored release NOT started: the attempt could not be made durable \\(state write made invalid progress \\(0\\)\\)`), 90000, n);
  assert.equal(front.held.length, 1, "b's release reached no relay");
  fs.writeFileSync(ctl, "{}");
  await new Promise((ok) => setTimeout(ok, 4000));   // checkpoints resume
  st = stateOf(h.stateFile);
  assert.ok((st.releaseIntents || []).find((x) => x.id === a)?.txs.some((x) => x.sponsored && x.intents.length >= 1), "a's signed lease is still journaled");
  const lines = fs.readFileSync(audit, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.length >= 5, `state replacements observed (${lines.length})`);
  assert.deepEqual(lines.filter((x) => !x.fsynced), [], "no replacement of the state file by an unsynced temp file, ever");
});

/** a second operator key on the rig's registry (anvil #3, funded), with the app owner's payout declaration (self-hosted) */
async function secondOperator(w) {
  const endpoint = "https://host-b.independent.test", enclaveId = viem.keccak256(viem.toBytes(endpoint));
  await w.r.write(w.r.wc(RIG.KEYS.other), w.r.addresses.registry, w.r.A.registry4.abi, "register", [endpoint, "independent/host", "0x" + "00".repeat(32), 1000n, 0n,
    "0x0000000000000000000000000000000000000000"]);
  await w.r.write(w.owner, w.r.addresses.registry, w.r.A.registry4.abi, "setPayoutWallet", [enclaveId]);
  return { key: RIG.KEYS.other, account: privateKeyToAccount(RIG.KEYS.other), endpoint, enclaveId };
}
const clientOf = (w, account, relayUrl, deployment = w.deployment) => B.createLeaseClient({ client: w.r.pc, clients: [w.r.pc], account, reserve: deployment.reserve,
  deployment, relays: [relayUrl], allowLoopbackHttp: true, confirmations: 0, requestTimeoutMs: 5000 });

test("10. operator rotation: the restarted host's DIFFERENT key (higher nonce lane) never settles the old key's pending release; it lands, then settles", T, async (t) => {
  begin(t);
  const w = await world({ minClaimInterval: 0, claimCooldown: 0 });
  const [id] = w.paid;
  const opB = await secondOperator(w);
  // key B leases the deployment twice first: B's executor nonce lane for it reaches 4
  const cB = clientOf(w, opB.account, w.relays[1].url);
  for (let i = 0; i < 2; i++) { await cB.claim(id, opB.enclaveId); await cB.release(id); }
  assert.equal(await w.r.pc.readContract({ address: opB.account.address, abi: B.EXECUTOR_ABI, functionName: "nonceOf", args: [id] }), 4n);
  // the host (key A) adopts it and signs its release at A's nonce 1; the relay holds it; the host dies
  const fromBlock = (await w.r.pc.getBlockNumber({ cacheTime: 0 })) + 1n;   // events are inclusive: after B's own releases
  const front = await holdingRelay(w.relays[0].url, { forward: true });
  const h1 = await startHost(w, w.env([front.url]));
  await registeredThenZero(w, h1);
  await h1.waitLog(new RegExp(`\\[claim\\] ${id} adopted`), 120000);
  MR.api(h1, "POST", `/v1/deployments/${id}/release`, await MR.login(h1)).catch(() => {});
  await until(() => /sponsored release 1\/4 lease nonce 1 \(.*pending/.test(h1.stdout()), 60000, "A's release pending at nonce 1");
  h1.kill();
  const it = (stateOf(h1.stateFile).releaseIntents || []).find((x) => x.id === id);
  const x = it.txs.find((tx) => tx.sponsored).intents[0];
  assert.deepEqual([x.operator, x.reserve, x.executor, x.chainId, x.ledger],
    [OPERATOR.toLowerCase(), w.reserve.toLowerCase(), w.executor.toLowerCase(), 8453, w.L.toLowerCase()], "the signed lease's identity is journaled");
  // the box restarts with key B (another endpoint): B's lane (4) is not A's (1): the release stays HELD
  const h2 = await startHost(w, w.env([w.relays[1].url]), { stateFile: h1.stateFile, host: { key: opB.key, endpoint: opB.endpoint } });
  await h2.waitLog(/\[release\] restored 1 unresolved release\(s\)/, 30000);
  await new Promise((ok) => setTimeout(ok, 10000));   // several resolver passes
  assert.doesNotMatch(h2.stdout(), new RegExp(`\\[release\\] ${id} (gone|released|gave-up|not-held|lapsing)|sponsored release 2/4`), "not fenced by key B's nonce, not re-sent");
  assert.ok((stateOf(h2.stateFile).releaseIntents || []).some((y) => y.id === id), "the hold is still journaled");
  // A's held release finally lands: the B process settles it RELEASED from A's verified receipt
  await forwardHeld(w, front);
  await h2.waitLog(new RegExp(`\\[release\\] ${id} released \\(`), 120000).catch(async (e) => {
    const row = await MR.getRow(w.r, id);
    throw new Error(`${e.message.slice(0, 200)}\nforwarded: ${JSON.stringify(front.forwarded)}\nrunnerOperator ${row.runnerOperator}\n`
      + h2.stdout().split("\n").filter((l) => /\[release\]|\[state\]/.test(l)).slice(-20).join("\n"));
  });
  console.log(`# test 10: the relay answered the forwarded release: ${JSON.stringify(front.forwarded)}`);
  assert.deepEqual(await releaseEvents(w, id, fromBlock), ["release"]);
});

test("11. record rotation: a pending release signed under another reserve is not fenced by its nonce under the new record; only its deadline", T, async (t) => {
  begin(t);
  const w = await world();
  const [id] = w.paid;
  const front = await holdingRelay(w.relays[0].url, { forward: false });
  const h1 = await startHost(w, w.env([front.url], { TEST_LEASE_FIXTURE_TTL_SEC: "30" }));
  await registeredThenZero(w, h1);
  await h1.waitLog(new RegExp(`\\[claim\\] ${id} adopted`), 120000);
  MR.api(h1, "POST", `/v1/deployments/${id}/release`, await MR.login(h1)).catch(() => {});
  await until(() => /sponsored release 1\/4 lease nonce \d+ \(.*pending/.test(h1.stdout()), 60000, "the release pending");
  h1.kill();
  const x = (stateOf(h1.stateFile).releaseIntents || []).find((y) => y.id === id).txs.find((tx) => tx.sponsored).intents[0];
  // another operation of the same key under the SAME reserve consumes that nonce (it releases the lease)
  await clientOf(w, privateKeyToAccount(RIG.KEYS.operator), w.relays[1].url).release(id);
  // a NEW reviewed record (another reserve + executor on the same ledger) for the restarted host
  const reserve2 = await w.r.deploy(w.A.reserve, [w.L, w.r.addresses.registry, "0x0000000000000000000000000000000000000000",
    { maxGasPriceCeiling: 10n ** 9n, overheadClaimGas: 29_500, overheadRenewGas: 24_000, overheadReleaseGas: 7_000, minClaimInterval: 60, l1Bps: 0 }]);
  const executor2 = await w.r.deploy(w.A.executor, [reserve2]);
  await w.r.write(w.r.wc(RIG.KEYS.deployer), reserve2, w.A.reserve.abi, "bindExecutor", [executor2]);
  const bytes = Buffer.from(JSON.stringify({ format: "enclave-lease-gas-deployment/v1", chainId: 8453, reserve: reserve2, executor: executor2, ledger: w.L,
    registry: w.r.addresses.registry, reserveCodeHash: viem.keccak256(await w.r.pc.getCode({ address: reserve2 })), executorCodeHash: viem.keccak256(await w.r.pc.getCode({ address: executor2 })) }));
  const file2 = path.join(w.dir, "record-2.json"); fs.writeFileSync(file2, bytes);
  const h2 = await startHost(w, w.env([w.relays[1].url], { ENCLAVE_LEASE_GAS_FILE: file2, ENCLAVE_LEASE_GAS_DIGEST: "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex") }),
    { stateFile: h1.stateFile });
  await h2.waitLog(/\[release\] restored 1 unresolved release\(s\)/, 30000);
  // held until the deadline on the recorded chain, then closed - as "gone" (the other operation released it), never "released"
  await h2.waitLog(new RegExp(`\\[release\\] ${id} (gone|released) \\(`), 120000);
  const closedAt = Number((await w.r.pc.getBlock()).timestamp);
  assert.match(h2.stdout(), new RegExp(`\\[release\\] ${id} gone \\(`));
  assert.ok(closedAt > Number(x.deadline), `closed only after the signed deadline ${x.deadline} (chain ${closedAt}): no nonce fence across records`);
});

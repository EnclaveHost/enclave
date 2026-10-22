// Windows release durability (root review 15:04Z): the ACTUAL Windows chain module + Host class (shadow-win, rebased from
// current main) with app-funded leases and a ZERO-ETH operator. Every sponsored release is journaled strictly before a
// signature and before any relay sees a signed lease (network/lease-release-journal.mjs, in the shipped bundle); until it
// is settled from the chain the deployment is HELD (no claim, re-adoption or renewal), across a process restart.
//   1. relay answer lost -> pending; "restart" (a fresh chain module on the same journal) still holds; the real Host
//      refuses to re-adopt; the delayed landing is then settled RELEASED from its verified receipt;
//   2. a signed release that never lands: settled "expired" at its deadline (a fence; the lease is NOT reported released);
//   3. its lease nonce consumed by another operation: "consumed" (a fence, never this release's success);
//   4. the journal cannot be written: nothing signed, no relay POST;
//   5. a corrupt journal: every lease operation refused, the file never overwritten.
// Only test transports (loopback), a short lease deadline and the EVM's warped clock are adapted.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as B from "../client/lease-executor-client.mjs";
import { startWorld, haveAnvil } from "./helpers/b-world.mjs";

const chainUrl = new URL("../shadow-win/windows/node/chain.mjs", import.meta.url).href;
const fixtureUrl = new URL("./helpers/windows-runtime-fixture.mjs", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(chainUrl) && specifier === "./lease-gas-runtime.bundle.mjs") return { url: fixtureUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const T = { skip: !haveAnvil && "needs anvil", timeout: 180_000 };
let W, relay, op, owner, env, dir, serial = 0;
const saved = { ...process.env }, closers = [];
before(async () => {
  if (!haveAnvil) return;
  W = await startWorld();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "windows-release-journal-"));
  const k = generatePrivateKey(); await W.fund(privateKeyToAccount(k).address);
  relay = await B.startLeaseRelay({ client: W.pc, wallet: W.wc(k), deployment: { chainId: 8453, ...W.addr }, allowLoopbackHttp: true,
    now: () => Date.now() + (globalThis.leaseGasFixtureClockOffset || 0) });
  closers.push(() => relay.close());
  op = await W.operator("https://windows-release-journal.test");
  owner = await W.owner();
  await W.write(owner.key, W.addr.registry, W.A.registry.abi, "setPayoutWallet", [op.enclaveId]);   // self-hosted: rate 0
  const bytes = Buffer.from(JSON.stringify({ format: "enclave-lease-gas-deployment/v1", chainId: 8453,
    ...Object.fromEntries(["reserve", "executor", "ledger", "registry", "reserveCodeHash", "executorCodeHash"].map((x) => [x, W.addr[x]])) }));
  fs.writeFileSync(path.join(dir, "record.json"), bytes);
  env = { ENCLAVE_LEASE_GAS_FILE: path.join(dir, "record.json"), ENCLAVE_LEASE_GAS_DIGEST: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
    ENCLAVE_LEASE_GAS_RPCS: W.rpcUrl };
});
after(async () => {
  for (const c of closers.reverse()) { try { await c(); } catch {} }
  W?.stop(); hooks.deregister();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  delete globalThis.leaseGasFixtureClockOffset;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});
/** A fresh Windows chain module (a "process"), on `journal`, with these relays. */
async function boot(relays, journal, extra = {}) {
  for (const key of Object.keys(process.env)) if (/^(ENCLAVE_)?LEASE_GAS_|^TEST_LEASE_FIXTURE_/.test(key)) delete process.env[key];
  Object.assign(process.env, env, { ENCLAVE_LEASE_GAS_RELAYS: relays.join(","), BASE_RPCS: W.rpcUrl, NODE_OPERATOR_KEY: op.key }, extra);
  // the fixture clock follows the chain's (test 2/3 moves the chain past a deadline)
  globalThis.leaseGasFixtureClockOffset = Math.max(0, Number((await W.pc.getBlock()).timestamp) * 1000 - Date.now());
  const c = await import(chainUrl + "?boot=" + ++serial);
  c.loadOperator();
  c.addresses.deployments = W.addr.ledger; c.addresses.registry = W.addr.registry;
  c.setLeaseJournal(journal);
  return c;
}
/** A relay front: passes everything to the honest relay, except that it HOLDS release POSTs (never answers) and
 *  forwards them only after open(); counts POSTs by kind. */
async function front({ holdReleases = true } = {}) {
  const held = [], seen = []; let release; const opened = new Promise((ok) => (release = ok));
  const s = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const pass = async () => { const x = await fetch(relay.url + req.url, req.method === "POST" ? { method: "POST", headers: { "content-type": "application/json" }, body } : {});
      res.writeHead(x.status, { "content-type": "application/json" }); res.end(await x.text()); };
    if (req.method !== "POST") return pass();
    let kind = 0; try { kind = Number(JSON.parse(body.toString()).lease.kind); } catch {}
    seen.push(kind);
    if (kind !== 3 || !holdReleases) return pass();
    held.push(body);
    opened.then(() => fetch(relay.url + req.url, { method: "POST", headers: { "content-type": "application/json" }, body }).then((x) => x.text()).catch(() => {}));
  });
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok));
  closers.push(() => { s.closeAllConnections(); s.close(); });
  return { url: `http://127.0.0.1:${s.address().port}`, held, posts: (k) => seen.filter((x) => x === k).length, open: () => release() };
}
const journalOf = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const releases = async (id, fromBlock) => (await W.pc.getContractEvents({ address: W.addr.reserve, abi: W.A.reserve.abi, eventName: "LeaseGasPaid", fromBlock }))
  .filter((e) => e.args.id === id && Number(e.args.kind) === 3);
async function enrolled() { const id = await W.create(owner, { fund6: 0n }); await W.enable(owner, id, { p: { claimPolicy: 1 } }); return id; }

test("1. lost release answer + restart: the id stays HELD (chain module and the real Host), then the delayed landing settles RELEASED", T, async () => {
  const f = await front(), journal = path.join(dir, "j1.json");
  const fromBlock = await W.pc.getBlockNumber();
  const id = await enrolled();
  const c1 = await boot([f.url], journal);
  await c1.claimDeployment(id, op.enclaveId);
  await assert.rejects(c1.releaseDeployment(id), (e) => e.pending === true && /may still land/.test(e.message));
  assert.equal(f.held.length, 1);
  const j = journalOf(journal);
  assert.equal(j.releases.length, 1); assert.equal(j.releases[0].id, id.toLowerCase());
  assert.ok(j.releases[0].intents.length === 1 && j.releases[0].intents[0].deadline, "the signed lease was journaled before the relay saw it");
  assert.match(c1.releaseHold(id), /unresolved/);
  await assert.rejects(c1.renewDeployment(id), (e) => e.code === "ReleasePending");
  // the process dies; a new one on the same journal
  const c2 = await boot([relay.url], journal);
  assert.match(c2.releaseHold(id), /unresolved/, "the hold survives the restart");
  await assert.rejects(c2.claimDeployment(id, op.enclaveId), (e) => e.code === "ReleasePending");
  assert.deepEqual(await c2.resolvePendingReleases(), [{ id: id.toLowerCase(), outcome: "pending" }]);
  // the REAL Host (fresh dir holding that journal) refuses to re-adopt the id
  const hostDir = fs.mkdtempSync(path.join(dir, "host-"));
  fs.copyFileSync(journal, path.join(hostDir, "lease-release-journal.json"));
  const plain = await import(chainUrl);   // the instance host.mjs imports
  if (!plain.operatorAddress()) plain.loadOperator();
  plain.addresses.deployments = W.addr.ledger; plain.addresses.registry = W.addr.registry;
  const { Host } = await import(new URL("../shadow-win/windows/node/host.mjs", import.meta.url).href);
  const h = new Host({ dir: hostDir, endpoint: "https://windows-release-journal.test", name: "j", appsEnabled: true, cpuPricePerSec6: 1000, log: () => {} });
  h.chainReady = true;
  const r = await h.consider(id);
  assert.equal(r.accepted, false); assert.equal(r.standing, "held"); assert.match(r.reason, /sponsored release of this deployment is unresolved/);
  // the delayed landing: the relay finally sends the lease the dead process signed
  f.open();
  for (let i = 0; i < 40 && !/^0x0{40}$/i.test((await W.row(id)).runnerOperator); i++) await new Promise((ok) => setTimeout(ok, 250));
  const settled = await c2.resolvePendingReleases();
  assert.equal(settled.length, 1); assert.equal(settled[0].outcome, "released"); assert.match(settled[0].hash, /^0x[0-9a-f]{64}$/);
  assert.equal(c2.releaseHold(id), null);
  assert.equal((await releases(id, fromBlock)).length, 1, "exactly one release paid");
  assert.equal(await W.pc.getBalance({ address: op.address }), 0n);
});

test("2/3. fences are not success: a never-landing release settles 'expired'; one whose nonce another operation consumed settles 'consumed'", T, async () => {
  const f = await front();   // never opened: held releases never land
  const a = await enrolled(), b = await enrolled();
  const c = await boot([f.url], path.join(dir, "j2.json"), { TEST_LEASE_FIXTURE_TTL_SEC: "30" });
  await c.claimDeployment(a, op.enclaveId); await c.claimDeployment(b, op.enclaveId);
  await assert.rejects(c.releaseDeployment(a), (e) => e.pending === true);
  await assert.rejects(c.releaseDeployment(b), (e) => e.pending === true);
  // b: another operation of this operator consumes b's lease nonce (a release the test signs with the fixture key)
  const other = B.createLeaseClient({ client: W.pc, account: op.account, reserve: W.addr.reserve, deployment: { chainId: 8453, ...W.addr },
    relays: [relay.url], allowLoopbackHttp: true, confirmations: 0, now: () => Date.now() + (globalThis.leaseGasFixtureClockOffset || 0) });
  await other.release(b);
  // a: past its deadline on the chain's clock
  const now = (await W.pc.getBlock()).timestamp;
  await W.warpTo(now + 45n);
  globalThis.leaseGasFixtureClockOffset = Number((await W.pc.getBlock()).timestamp) * 1000 - Date.now();
  const settled = Object.fromEntries((await c.resolvePendingReleases()).map((x) => [x.id, x.outcome]));
  assert.equal(settled[a.toLowerCase()], "expired"); assert.equal(settled[b.toLowerCase()], "consumed");
  assert.equal((await W.row(a)).runnerOperator, op.address, "an expired fence is not a release: a's lease is still held");
  assert.equal(c.releaseHold(a), null); assert.equal(c.releaseHold(b), null);
  assert.equal(f.held.length, 2);
});

test("4. the journal cannot be written: nothing is signed and no relay sees a release", T, async () => {
  const f = await front({ holdReleases: false });
  const id = await enrolled();
  const ro = fs.mkdtempSync(path.join(dir, "ro-"));
  const c = await boot([f.url], path.join(ro, "journal.json"));
  await c.claimDeployment(id, op.enclaveId);
  fs.chmodSync(ro, 0o500);
  try {
    await assert.rejects(c.releaseDeployment(id), (e) => /app-funded release not sent/.test(e.message) && e.pending !== true);
    assert.equal(f.posts(3), 0, "no release POST to any relay");
    assert.equal((await W.row(id)).runnerOperator, op.address);
    assert.equal(c.releaseHold(id), null, "nothing signed, nothing to hold");
  } finally { fs.chmodSync(ro, 0o700); }
  await c.releaseDeployment(id);   // and once the disk works, the same release goes through
  assert.match((await W.row(id)).runnerOperator, /^0x0{40}$/i);
});

test("5. a corrupt journal: every lease operation is refused and the file is never overwritten", T, async () => {
  const f = await front({ holdReleases: false });
  const id = await enrolled();
  const journal = path.join(dir, "j5.json");
  fs.writeFileSync(journal, '{"version":1,"releases":[{"id":"0xtrunc');
  const c = await boot([f.url], journal);
  for (const send of [() => c.claimDeployment(id, op.enclaveId), () => c.renewDeployment(id), () => c.releaseDeployment(id)])
    await assert.rejects(send(), /release journal failed to load/);
  assert.match(c.releaseHold(id), /failed to load/);
  assert.equal(f.posts(1) + f.posts(2) + f.posts(3), 0);
  assert.equal(fs.readFileSync(journal, "utf8"), '{"version":1,"releases":[{"id":"0xtrunc');
});

/** move the chain (and the fixture clock every module here follows) forward */
async function advance(sec) {
  await W.warpTo((await W.pc.getBlock()).timestamp + BigInt(sec));
  globalThis.leaseGasFixtureClockOffset = Math.max(0, Number((await W.pc.getBlock()).timestamp) * 1000 - Date.now());
}

test("6. operator rotation: another key's higher nonce never settles a pending release; rotating back stays HELD; the late landing settles it", T, async () => {
  const f = await front();
  const opB = await W.operator("https://windows-release-journal-b.test");
  await W.write(owner.key, W.addr.registry, W.A.registry.abi, "setPayoutWallet", [opB.enclaveId]);
  const id = await W.create(owner, { fund6: 0n });
  await W.enable(owner, id, { p: { claimPolicy: 1, claimCooldown: 0 } });
  // B leases the deployment twice first: B's executor nonce lane for it reaches 4
  const cB = await boot([relay.url], path.join(dir, "j6-b.json"), { NODE_OPERATOR_KEY: opB.key });
  for (let i = 0; i < 2; i++) { await cB.claimDeployment(id, opB.enclaveId); await cB.releaseDeployment(id); await advance(61); }
  const laneB = await W.pc.readContract({ address: opB.address, abi: B.EXECUTOR_ABI, functionName: "nonceOf", args: [id] });
  assert.equal(laneB, 4n);
  // A claims (A's lane 0 -> 1) and signs its release at nonce 1; the relay holds it
  const journal = path.join(dir, "j6.json");
  const cA = await boot([f.url], journal);
  await cA.claimDeployment(id, op.enclaveId);
  await assert.rejects(cA.releaseDeployment(id), (e) => e.pending === true);
  const entry = journalOf(journal).releases[0];
  assert.equal(entry.intents[0].nonce, "1"); assert.equal(entry.intents[0].operator, op.address.toLowerCase());
  assert.equal(entry.intents[0].reserve, W.addr.reserve.toLowerCase()); assert.equal(entry.intents[0].executor, W.addr.executor.toLowerCase());
  assert.equal(entry.intents[0].chainId, 8453); assert.equal(entry.intents[0].ledger, W.addr.ledger.toLowerCase());
  // the box restarts with key B: B's lane (4) is not A's; nothing is settled, the hold stays
  const rotated = await boot([relay.url], journal, { NODE_OPERATOR_KEY: opB.key });
  assert.deepEqual(await rotated.resolvePendingReleases(), [{ id: id.toLowerCase(), outcome: "pending" }]);
  assert.match(rotated.releaseHold(id), /unresolved/);
  // and back to key A: still held - no claim, no renewal
  const back = await boot([relay.url], journal);
  assert.match(back.releaseHold(id), /unresolved/);
  await assert.rejects(back.renewDeployment(id), (e) => e.code === "ReleasePending");
  // the relay finally sends A's signed release: settled RELEASED from its verified receipt (as A's), even by the B process
  f.open();
  for (let i = 0; i < 40 && !/^0x0{40}$/i.test((await W.row(id)).runnerOperator); i++) await new Promise((ok) => setTimeout(ok, 250));
  const settled = await rotated.resolvePendingReleases();
  assert.equal(settled.length, 1); assert.equal(settled[0].outcome, "released");
});

test("7. record rotation: a pending release signed under another reserve is not fenced by its nonce here; only its deadline settles it", T, async () => {
  const f = await front();   // never opened
  const id = await enrolled();
  const journal = path.join(dir, "j7.json");
  const c1 = await boot([f.url], journal, { TEST_LEASE_FIXTURE_TTL_SEC: "30" });
  await c1.claimDeployment(id, op.enclaveId);
  await assert.rejects(c1.releaseDeployment(id), (e) => e.pending === true);
  // another operation of THIS operator under the SAME reserve consumes that nonce (and releases the lease)
  const other = B.createLeaseClient({ client: W.pc, account: op.account, reserve: W.addr.reserve, deployment: { chainId: 8453, ...W.addr },
    relays: [relay.url], allowLoopbackHttp: true, confirmations: 0, now: () => Date.now() + (globalThis.leaseGasFixtureClockOffset || 0) });
  await other.release(id);
  // the box restarts on a NEW reviewed record (another reserve/executor): the old lease's identity is not this record's
  const R2 = await W.newReserve();
  const bytes = Buffer.from(JSON.stringify({ format: "enclave-lease-gas-deployment/v1", chainId: 8453, reserve: R2.reserve, executor: R2.executor,
    ledger: W.addr.ledger, registry: W.addr.registry, reserveCodeHash: R2.reserveCodeHash, executorCodeHash: R2.executorCodeHash }));
  fs.writeFileSync(path.join(dir, "record-r2.json"), bytes);
  const r2env = { ENCLAVE_LEASE_GAS_FILE: path.join(dir, "record-r2.json"), ENCLAVE_LEASE_GAS_DIGEST: "sha256:" + createHash("sha256").update(bytes).digest("hex") };
  const c2 = await boot([relay.url], journal, r2env);
  // HELD, with the reason: the recorded reserve/executor is not this record's, so neither its nonce nor a receipt here settles it
  assert.deepEqual(await c2.resolvePendingReleases(), [{ id: id.toLowerCase(),
    outcome: "held: the lease was signed under another (or an unrecorded) reserve/executor/ledger: held until its deadline on its chain" }],
    "a nonce under another record is no fence here");
  assert.match(c2.releaseHold(id), /unresolved/);
  // under the ORIGINAL record the same entry IS fenced by its own lane
  const c1b = await boot([relay.url], path.join(dir, "j7-copy.json"));
  fs.copyFileSync(journal, path.join(dir, "j7-copy.json")); c1b.setLeaseJournal(path.join(dir, "j7-copy.json"));
  assert.deepEqual((await c1b.resolvePendingReleases()).map((x) => x.outcome), ["consumed"]);
  // past its deadline on the recorded chain: the new-record process may settle it - as a fence, never as released
  await advance(45);
  assert.deepEqual((await c2.resolvePendingReleases()).map((x) => x.outcome), ["expired"]);
  assert.equal(c2.releaseHold(id), null);
});

test("8. an entry whose identity was never recorded (an older journal) is HELD, never guessed from the current key", T, async () => {
  const f = await front();
  const id = await enrolled();
  const journal = path.join(dir, "j8.json");
  const c = await boot([f.url], journal, { TEST_LEASE_FIXTURE_TTL_SEC: "30" });
  await c.claimDeployment(id, op.enclaveId);
  await assert.rejects(c.releaseDeployment(id), (e) => e.pending === true);
  const j = journalOf(journal);
  for (const k of ["chainId", "reserve", "executor", "ledger"]) delete j.releases[0].intents[0][k];
  fs.writeFileSync(journal, JSON.stringify(j));
  await advance(45);   // even past its deadline: the chain it was signed for is unknown
  const c2 = await boot([relay.url], journal);
  const r = await c2.resolvePendingReleases();
  assert.equal(r.length, 1); assert.match(r[0].outcome, /^held: the lease was signed for chain unknown/);
  assert.match(c2.releaseHold(id), /unresolved/);
  assert.equal(journalOf(journal).releases.length, 1, "the old entry is kept, not discarded");
});

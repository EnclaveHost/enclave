// shared allocation r1 (AUTHORED, NOT RUN): the ONE owner, its ledger over the existing owned primitives, and the
// authenticated guestd-control/1 request path with two role clients. TEST exclusion/sampler/coverage are labelled TEST
// in helpers/alloc-fixture.mjs; nothing here is Windows, NTFS, commit or native evidence.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { establishLogDomain, establishDurableDomain, openDurableAllocationStore, openAllocationOwner, logStore, LEDGER_PURPOSE, validateDomain }
  from "../../control/windows/vbslike/manager/allocation-owner.mjs";
import { AllocationClient } from "../../control/windows/vbslike/manager/allocation-service.mjs";
import { initializeOwnedLog, openOwnedLog, TEST_inProcessExclusion } from "../../control/windows/vbslike/manager/win-durable.mjs";
import { ownerRig, capacityFor, vmMiB, DOMAIN, COVER, deployment, tmpDir, testClock } from "./helpers/alloc-fixture.mjs";

const epoch = () => crypto.randomBytes(16).toString("hex");
const req = (id, extra = {}) => ({ kind: "vm", request: { id, name: deployment("e6"), vmInstanceId: `inst-${id}`, appId: "aa".repeat(32) }, physicalMiB: vmMiB(), ttlMs: 60_000, ...extra });
async function both(rig) { const g = rig.client("general"), n = rig.client("native"); await g.register({ epoch: epoch(), baseline: [] }); await n.register({ epoch: epoch(), baseline: [] }); return { g, n }; }
const sampler = async () => ({ availablePhysicalMiB: 1 << 20, availableCommitMiB: 1 << 20, at: performance.now(), source: "TEST" });

test("establishment is explicit; normal open refuses missing, foreign, unestablished, torn and other-domain ledgers", async (t) => {
  const dir = tmpDir(t), ex = TEST_inProcessExclusion(), file = path.join(dir, "a.log");
  const open = (f) => openOwnedLog(f, { purpose: LEDGER_PURPOSE, exclusion: ex, platform: "linux" });
  assert.throws(() => open(file), /owned journal unavailable/);                       // missing: never created at open
  assert.throws(() => validateDomain({ ...DOMAIN, floorMiB: 16384 }), /at least 18432/);
  assert.throws(() => validateDomain({ ...DOMAIN, isolated: false }), /isolated/);
  establishLogDomain(file, { domain: DOMAIN, exclusion: ex, platform: "linux" });
  assert.throws(() => establishLogDomain(file, { domain: DOMAIN, exclusion: ex, platform: "linux" }), /EEXIST/);
  let h = open(file);
  try { assert.throws(() => openAllocationOwner({ store: logStore(h), domainId: "test-another-domain", sampler, coverage: async () => COVER }), /belongs to domain/); }
  finally { h.release(); }
  const foreign = path.join(dir, "permit.log"); initializeOwnedLog(foreign, { purpose: "enclave-manager-permit/1" });
  assert.throws(() => open(foreign), /purpose/);
  const bare = path.join(dir, "bare.log"); initializeOwnedLog(bare, { purpose: LEDGER_PURPOSE });
  h = open(bare);
  try { assert.throws(() => openAllocationOwner({ store: logStore(h), domainId: DOMAIN.id, sampler, coverage: async () => COVER }), /no established domain/); }
  finally { h.release(); }
  fs.appendFileSync(file, '{"seq":99,"kind":"alloc-acq');                              // a torn final record
  h = open(file);
  try { assert.throws(() => logStore(h), /torn tail/); } finally { h.release(); }
  assert.ok(fs.readFileSync(file, "utf8").endsWith('"alloc-acq'), "nothing was truncated or rewritten");
});

test("ONE owner serializes two authenticated roles: coverage gates, full physical+commit persisted, no oversubscription", async (t) => {
  const rig = await ownerRig(t, { capacity: capacityFor(1) });
  const g = rig.client("general"), n = rig.client("native");
  await g.register({ epoch: epoch(), baseline: [] });
  await assert.rejects(g.acquire(req("a")), /coverage incomplete.*native has not acknowledged/);
  await n.register({ epoch: epoch(), baseline: [] });
  const out = await Promise.allSettled([g.acquire(req("a")), n.acquire(req("b"))]);
  assert.equal(out.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(out.find((x) => x.status === "rejected").reason.status, 507);
  const active = Object.values(rig.owner.snapshot().active);
  assert.equal(active.length, 1);
  assert.equal(active[0].physicalMiB, vmMiB()); assert.equal(active[0].commitMiB, vmMiB() + DOMAIN.vmCommitOverheadMiB);
  assert.equal(active[0].state, "reserved"); assert.ok(active[0].terms.needPhysicalMiB >= DOMAIN.floorMiB + vmMiB());
  // the reservation is IN THE LEDGER (persisted before the grant): a raw replay of the same file shows it
  const replay = fs.readFileSync(rig.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === "alloc-acquire");
  assert.equal(replay.length, 1); assert.equal(replay[0].data.rec.rid, active[0].rid);
  const [sg, sn] = await Promise.all([g.status(), n.status()]);
  assert.equal(sg.ownerIncarnation, sn.ownerIncarnation, "both clients reach the same owner incarnation");
  assert.deepEqual(sg.coverageGaps, []); assert.equal(sg.qualification, "TEST");
});

test("unknown/stale sample, missing coverage term and a higher live floor refuse; nothing defaults to zero", async (t) => {
  const rig = await ownerRig(t, { capacity: capacityFor(1) });
  const { g } = await both(rig);
  rig.sample.commit = undefined;
  await assert.rejects(g.acquire(req("a")), /unknown or not finite/);
  rig.sample.commit = capacityFor(1).commit; rig.sample.fail = "TEST sampler down";
  await assert.rejects(g.acquire(req("a")), /sample unavailable/);
  rig.sample.fail = null; delete rig.cover.physical.relayMiB;
  await assert.rejects(g.acquire(req("a")), /coverage term physical\.relayMiB is unknown/);
  rig.cover.physical.relayMiB = 1; rig.sample.liveFloorMiB = DOMAIN.floorMiB + 4096;
  await assert.rejects(g.acquire(req("a")), /below the floor/);
  rig.sample.liveFloorMiB = undefined;
  await assert.rejects(g.acquire({ ...req("a"), kind: "qualification" }), /commitMiB must be stated/);
  assert.ok((await g.acquire(req("a"))).rid);
});

test("restart keeps every unresolved reservation exactly; stale incarnations refuse; continuity ends new boundary entries", async (t) => {
  const rig = await ownerRig(t, { capacity: capacityFor(2) });
  const { g } = await both(rig);
  const a = await g.acquire(req("a")), b = await g.acquire(req("b"));
  await g.enter({ rid: a.rid, boundary: "define", request: req("a").request, memMiB: vmMiB() });
  const before = rig.owner.snapshot().active, inc0 = rig.owner.ownerIncarnation;
  await rig.restart();
  const after = rig.owner.snapshot();
  assert.notEqual(after.ownerIncarnation, inc0); assert.equal(after.ownerGeneration, 2);
  assert.deepEqual(after.active[a.rid], before[a.rid]); assert.deepEqual(after.active[b.rid], before[b.rid]);
  await assert.rejects(g.acquire(req("c")), /new handshake|not registered with this owner incarnation|stale owner incarnation/);
  const n = rig.client("native");
  await g.register({ epoch: epoch(), baseline: [] }); await n.register({ epoch: epoch(), baseline: [] });
  await assert.rejects(g.enter({ rid: a.rid, boundary: "start", request: req("a").request, vmId: crypto.randomUUID() }), /predates this owner incarnation|state define-entered|continuity/);
  await rig.owner.sweep();
  const s = rig.owner.snapshot();
  assert.equal(s.active[b.rid], undefined, "an unentered reservation of the ended incarnation is released by the owner's own record");
  assert.equal(s.active[a.rid].state, "define-entered", "a possibly-allocating reservation is retained");
  await assert.rejects(g.observe({ rid: a.rid, outcome: "absent", evidence: { kind: "stop-confirmed", vmId: crypto.randomUUID(), removed: true } }), /exact removal evidence/);
  await g.observe({ rid: a.rid, outcome: "absent", evidence: { kind: "cleanup-removed", name: "enclave-native-inst-a", found: false, removed: false } });
  assert.equal(Object.keys(rig.owner.snapshot().active).length, 0);
});

test("authenticated path: per-role keys, unauthenticated/oversize/role-mismatch refused", async (t) => {
  const rig = await ownerRig(t);
  await assert.rejects(new AllocationClient({ url: rig.url, role: "general", key: crypto.randomBytes(32) }).register({ epoch: epoch(), baseline: [] }), /not ours/);
  await assert.rejects(new AllocationClient({ url: rig.url, role: "native", key: rig.keys.general }).register({ epoch: epoch(), baseline: [] }), /not ours/);
  const raw = (p, body) => fetch(rig.url + p, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(5000) });
  assert.equal((await raw("/alloc/general/allocation/acquire", "{}")).status, 401);
  const declaredOversize = await new Promise((resolve, reject) => {
    const r = http.request(rig.url + "/alloc/general/allocation/acquire", { method: "POST", headers: { "content-length": String(70 * 1024) } }, (res) => { res.resume(); resolve(res.statusCode); });
    r.on("error", reject); r.flushHeaders();                                    // headers only: refused on the declared length
  });
  assert.equal(declaredOversize, 413);
  assert.equal((await raw("/alloc/other/allocation/acquire", "{}")).status, 404);
  const { g } = await both(rig);
  await assert.rejects(g.acquire({ ...req("a"), role: "native" }), /another role/);
  assert.throws(() => new AllocationClient({ url: "http://10.0.0.1:1", role: "general", key: rig.keys.general }), /loopback/);
  assert.equal(Object.keys(rig.owner.snapshot().active).length, 0);
});

test("a qualification hold consumes real capacity until its holder ends it", async (t) => {
  const rig = await ownerRig(t, { capacity: capacityFor(1) });
  const { g, n } = await both(rig);
  const q = { id: "qual-1", name: "qualification-r1", vmInstanceId: "qual-1", appId: "bb".repeat(32) };
  const hold = await g.acquire({ kind: "qualification", request: q, physicalMiB: vmMiB(), commitMiB: vmMiB() + DOMAIN.vmCommitOverheadMiB, ttlMs: 60_000 });
  await assert.rejects(n.acquire(req("b")), /floor|exhausted/);
  await assert.rejects(n.observe({ rid: hold.rid, outcome: "absent", evidence: { kind: "qualification-ended", request: q } }), /another role/);
  await g.observe({ rid: hold.rid, outcome: "absent", evidence: { kind: "qualification-ended", request: q } });
  assert.ok((await n.acquire(req("b"))).rid);
});

test("expiry refuses new boundary entries but never releases an entered reservation", async (t) => {
  const clock = testClock();
  const rig = await ownerRig(t, { capacity: capacityFor(1), clock });
  const { g, n } = await both(rig);
  const a = await g.acquire(req("a", { ttlMs: 1000 }));
  await g.enter({ rid: a.rid, boundary: "define", request: req("a").request, memMiB: vmMiB() });
  clock.advance(5000);
  await rig.owner.sweep();
  assert.equal(rig.owner.snapshot().active[a.rid].state, "define-entered");
  await assert.rejects(g.enter({ rid: a.rid, boundary: "start", request: req("a").request, vmId: crypto.randomUUID() }), /expired/);
  await assert.rejects(n.acquire(req("b")), /floor|exhausted/);
});

test("ledger persistence failure closes the owner for every new admission (owner loss)", async (t) => {
  const dir = tmpDir(t), ex = TEST_inProcessExclusion(), file = path.join(dir, "loss.log");
  establishLogDomain(file, { domain: DOMAIN, exclusion: ex, platform: "linux" });
  let broken = false;
  const fsImpl = { ...fs, writeSync: (...a) => { if (broken) throw Error("TEST storage gone"); return fs.writeSync(...a); } };
  const owner = openAllocationOwner({ store: logStore(openOwnedLog(file, { purpose: LEDGER_PURPOSE, exclusion: ex, platform: "linux", fsImpl })), domainId: DOMAIN.id, sampler, coverage: async () => COVER });
  t.after(() => owner.close());
  const m = (role) => ({ managerIncarnation: crypto.randomBytes(16).toString("hex"), epoch: epoch(), baseline: [], role });
  const gm = m("general"), nm = m("native");
  await owner.register("general", gm); await owner.register("native", nm);
  broken = true;
  await assert.rejects(owner.acquire("general", { ...req("a"), managerIncarnation: gm.managerIncarnation, ownerIncarnation: owner.ownerIncarnation }), /persistence uncertain/);
  broken = false;
  await assert.rejects(owner.acquire("native", { ...req("b"), managerIncarnation: nm.managerIncarnation, ownerIncarnation: owner.ownerIncarnation }), /owner closed/);
  assert.match(owner.status().closed, /persistence uncertain/);
});

test("Linux owned-durable-state store (real flock; NOT Windows): explicit establishment, retained reservations, refused missing", async (t) => {
  const dir = tmpDir(t), file = path.join(dir, "alloc.json");
  await assert.rejects(openDurableAllocationStore(file), /missing|established/);
  await establishDurableDomain(path.join(dir, "fresh.json"), { domain: DOMAIN });
  await assert.rejects(establishDurableDomain(path.join(dir, "fresh.json"), { domain: DOMAIN }), /refusing to establish/);
  const f = path.join(dir, "fresh.json");
  let owner = openAllocationOwner({ store: await openDurableAllocationStore(f), domainId: DOMAIN.id, sampler, coverage: async () => COVER });
  const gm = { managerIncarnation: crypto.randomBytes(16).toString("hex"), epoch: epoch(), baseline: [{ id: "hvexisting", physicalMiB: 4096, launching: true }] };
  await owner.register("general", gm); await owner.register("native", { managerIncarnation: crypto.randomBytes(16).toString("hex"), epoch: epoch(), baseline: [] });
  const a = await owner.acquire("general", { ...req("a"), managerIncarnation: gm.managerIncarnation, ownerIncarnation: owner.ownerIncarnation });
  const kept = owner.snapshot().active;
  await owner.close("TEST restart");
  owner = openAllocationOwner({ store: await openDurableAllocationStore(f), domainId: DOMAIN.id, sampler, coverage: async () => COVER });
  t.after(() => owner.close());
  assert.deepEqual(owner.snapshot().active, kept);
  assert.equal(Object.values(kept).filter((r) => r.kind === "baseline" && r.launching).length, 1, "an already-entered start stays accounted");
  assert.ok(owner.snapshot().active[a.rid]);
  assert.match(owner.status().qualification, /unqualified/);
});

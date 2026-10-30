// shared allocation r1 (AUTHORED, NOT RUN): ONE owner, TWO actual manager consumers (installed-source Manager /
// ProtectedManager over real HTTP, HyperVPartitionBackend, the actual WmiHyperVLauncher.start with its define/start
// boundaries), each through its own authenticated AllocationClient. The PowerShell host, sampler, coverage numbers and
// journal exclusion are TEST (helpers/alloc-fixture.mjs); no Hyper-V, Windows, commit or native evidence is produced.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { derive } from "../../control/windows/vbslike/manager/derive.mjs";
import { ownerRig, consumer, capacityFor, deployment, testClock, vmMiB, vectors, ProtectedManager } from "./helpers/alloc-fixture.mjs";

async function waitFor(fn, ms = 5000) { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw Error("waitFor timed out"); await new Promise((r) => setTimeout(r, 10)); } }
const active = (rig) => Object.values(rig.owner.snapshot().active);
async function pair(t, { capacity = capacityFor(1), clock, nativeKlass } = {}) {
  const rig = await ownerRig(t, { capacity, ...(clock ? { clock } : {}) });
  const G = await consumer(t, { role: "general", rig });
  const N = await consumer(t, { role: "native", rig, ...(nativeKlass ? { Klass: nativeKlass } : {}) });
  rig.sample.hosts = [G.host, N.host];
  return { rig, G, N };
}

test("positive: direct POST /vms -> shared reservation -> actual WMI define/start -> reflection; Stop settles; the other role then allocates", async (t) => {
  const rig = await ownerRig(t, { capacity: capacityFor(1) });
  const G = await consumer(t, { role: "general", rig }), N = await consumer(t, { role: "native", rig, install: false });
  rig.sample.hosts = [G.host, N.host];
  const early = await G.post(deployment("e0"));
  assert.equal(early.body.status, "failed"); assert.match(early.body.reason, /coverage incomplete/);
  assert.equal(G.host.count("define"), 0, "refused before New-CustomVM");
  await N.install();
  const r1 = await G.post(deployment("e1"));
  assert.equal(r1.status, 201); assert.equal(r1.body.status, "starting");
  await G.alloc.settled();
  assert.deepEqual(G.host.calls.filter((c) => c === "define" || c === "start"), ["define", "start"]);
  const rec = active(rig).find((r) => r.request.id === r1.body.id);
  assert.equal(rec.state, "reflected"); assert.deepEqual(rec.entered, ["define", "start"]);
  assert.equal(rec.vmId, G.manager.domains.get(r1.body.id).handle.vmId);
  assert.equal(rec.physicalMiB, G.manager.domains.get(r1.body.id).physicalMemoryMiB);
  const r2 = await N.post(deployment("e2"));
  assert.equal(r2.body.status, "failed"); assert.match(r2.body.reason, /shared allocation refused: .*(floor|exhausted)/);
  assert.equal(N.host.count("define"), 0, "the other role is refused before create");
  assert.equal((await G.del(r1.body.id)).status, 200);
  await G.alloc.settled();
  assert.equal(G.host.count("removeById"), 1);
  assert.equal(active(rig).length, 0, "settled only on the launcher's exact removal by VM Id");
  const r3 = await N.post(deployment("e2"));
  assert.equal(r3.body.status, "starting"); assert.equal(N.host.count("define"), 1);
  await N.alloc.settled();
  assert.equal(active(rig)[0].role, "native"); assert.equal(active(rig)[0].state, "reflected");
  assert.equal(G.manager.health().allocation.nativeQualified, false);
});

test("concurrent cross-role direct requests cannot oversubscribe the one owner", async (t) => {
  const { rig, G, N } = await pair(t, { capacity: capacityFor(1) });
  const [a, b] = await Promise.all([G.post(deployment("e3")), N.post(deployment("e4"))]);
  const statuses = [a.body.status, b.body.status].sort();
  assert.deepEqual(statuses, ["failed", "starting"]);
  assert.equal(G.host.count("define") + N.host.count("define"), 1);
  await Promise.all([G.alloc.settled(), N.alloc.settled()]);
  assert.equal(active(rig).length, 1);
});

test("protected raw stage (spawnProtectedInternal) reaches the same shared checks", async (t) => {
  const { rig, G, N: P } = await pair(t, { capacity: capacityFor(1), nativeKlass: ProtectedManager });
  const g = await G.post(deployment("e5"));
  await G.alloc.settled();
  const ppId = () => "pp" + crypto.randomBytes(16).toString("hex");
  const refused = await P.manager.spawnProtectedInternal({ ...P.body(deployment("e6")), id: ppId() });
  assert.equal(refused.status, "failed"); assert.match(refused.reason, /shared allocation refused/);
  assert.equal(P.host.count("define"), 0);
  await G.del(g.body.id); await G.alloc.settled();
  const ok = await P.manager.spawnProtectedInternal({ ...P.body(deployment("e6")), id: ppId() });
  assert.equal(ok.status, "starting"); assert.equal(P.host.count("define"), 1);
  await P.alloc.settled();
  assert.equal(active(rig).find((r) => r.request.id === ok.id).state, "reflected");
});

test("no bypass: launch is non-writable, replacing backend.launcher does not reach start, a direct launcher.start is refused before define", async (t) => {
  const { G } = await pair(t, { capacity: capacityFor(2) });
  assert.throws(() => { G.backend.launch = async () => ({ vmId: "bypass" }); }, TypeError);
  G.backend.launcher = { start: async () => { throw Error("BYPASS launcher reached"); }, boundary: null };
  const r = await G.post(deployment("e7"));
  assert.equal(r.body.status, "starting", "the constructor-captured original launcher, behind the gate, served the launch");
  assert.equal(G.host.count("define"), 1);
  const { record, component } = vectors();
  const mapping = derive({ record, component });
  const instanceId = "direct-bypass-01";
  await assert.rejects(G.launcher.start(mapping, { instanceId, identity: { id: "hvdirect", name: deployment("e8"), instanceId, appId: mapping.appId } }),
    /no shared reservation reached the WMI define boundary/);
  assert.equal(G.host.count("define"), 1, "nothing was created by the direct call");
  const forged = Object.freeze({ rid: "00".repeat(16), ownerIncarnation: "00".repeat(16), request: {}, physicalMiB: vmMiB() });
  await assert.rejects(G.launcher.start(mapping, { instanceId, allocation: forged, identity: { id: "hvdirect", name: deployment("e8"), instanceId, appId: mapping.appId } }),
    /not this manager's live reservation/);
  assert.equal(G.host.count("define"), 1);
});

test("expiry with an in-flight start keeps the reservation counted; the start completes and reflects", async (t) => {
  const clock = testClock();
  const { rig, G, N } = await pair(t, { capacity: capacityFor(1), clock });
  let release; G.host.hold.start = new Promise((r) => { release = r; });
  const p = G.post(deployment("e9"));
  await waitFor(() => G.host.count("start") === 1);
  clock.advance(10 * 60_000);
  await rig.owner.sweep();
  assert.equal(active(rig).length, 1); assert.equal(active(rig)[0].state, "start-entered");
  const n = await N.post(deployment("ea"));
  assert.equal(n.body.status, "failed"); assert.equal(N.host.count("define"), 0);
  release();
  assert.equal((await p).body.status, "starting");
  await G.alloc.settled();
  assert.equal(active(rig)[0].state, "reflected");
});

test("in-place installation on a serving manager with an in-flight start: same objects, no PowerShell, no stop/teardown/recover/reclaim", async (t) => {
  const rig = await ownerRig(t, { capacity: capacityFor(3) });
  const G = await consumer(t, { role: "general", rig, install: false }), N = await consumer(t, { role: "native", rig });
  rig.sample.hosts = [G.host, N.host];
  const s1 = await G.post(deployment("eb"));
  let release; G.host.hold.start = new Promise((r) => { release = r; });
  const p2 = G.post(deployment("ec"));
  await waitFor(() => G.host.count("start") === 2);
  const m = G.manager, domains = m.domains, epoch = m.epoch, judging = m.judging, removedIds = m.removedIds;
  const rec1 = domains.get(s1.body.id), h1 = rec1.handle;
  const inflight = [...domains.values()].find((r) => r.launching);
  let reclaimed = 0; m.onReclaim = () => { reclaimed++; }; const onReclaim = m.onReclaim;
  const callsBefore = [...G.host.calls];
  await G.install();
  assert.equal(m.domains, domains); assert.equal(m.epoch, epoch); assert.equal(m.judging, judging); assert.equal(m.removedIds, removedIds);
  assert.equal(domains.get(s1.body.id), rec1); assert.equal(rec1.handle, h1); assert.equal(domains.get(inflight.id), inflight);
  assert.equal(m.onReclaim, onReclaim); assert.equal(reclaimed, 0);
  assert.deepEqual(G.host.calls, callsBefore, "installation made no PowerShell call (no survey, stop, removal or teardown)");
  const base = active(rig).filter((r) => r.kind === "baseline" && r.role === "general");
  assert.equal(base.length, 2); assert.equal(base.filter((r) => r.launching).length, 1);
  release();
  assert.equal((await p2).body.status, "starting", "the already-entered start completed");
  await G.alloc.reconcile();
  assert.ok(active(rig).filter((r) => r.kind === "baseline").every((r) => r.state === "reflected"));
  const r3 = await G.post(deployment("ed"));
  assert.equal(r3.body.status, "starting"); await G.alloc.settled();
  assert.equal(active(rig).find((r) => r.request.id === r3.body.id).state, "reflected");
  assert.equal(rec1.status, "starting"); assert.equal(G.host.count("removeById"), 0);
});

test("runtime owner loss closes new admissions only; serving records and explicit Stop continue; the settlement is retained for retry", async (t) => {
  const { rig, G, N } = await pair(t, { capacity: capacityFor(2) });
  const s = await G.post(deployment("ee")); await G.alloc.settled();
  const rec = G.manager.domains.get(s.body.id), handle = rec.handle;
  rig.owner.close("TEST owner lost");
  const n = await N.post(deployment("ef"));
  assert.equal(n.body.status, "failed"); assert.match(n.body.reason, /closed/); assert.equal(N.host.count("define"), 0);
  assert.equal(G.manager.domains.get(s.body.id), rec); assert.equal(rec.handle, handle); assert.equal(rec.status, "starting");
  assert.equal((await G.del(s.body.id)).status, 200, "explicit Stop is not blocked by the owner");
  await G.alloc.settled();
  assert.equal(G.alloc.status().pendingSettlements, 1, "the stop evidence is retained for the next owner, never dropped");
});

test("owner restart: stale clients are refused until reconcile re-registers; retained reservations still settle exactly", async (t) => {
  const { rig, G, N } = await pair(t, { capacity: capacityFor(2) });
  const s = await G.post(deployment("f0")); await G.alloc.settled();
  const rid = active(rig)[0].rid;
  await rig.restart();
  const stale = await N.post(deployment("f1"));
  // the restarted owner has a new guestd-control/1 instance: the first signed POST is refused as outcome-unknown (never repeated)
  assert.equal(stale.body.status, "failed"); assert.match(stale.body.reason, /new handshake|not registered with this owner incarnation|stale owner/);
  assert.equal(N.host.count("define"), 0);
  await G.alloc.reconcile(); await N.alloc.reconcile();
  assert.equal(active(rig).filter((r) => r.role === "general").length, 1, "re-registration did not double-count the reflected VM");
  assert.ok(active(rig).find((r) => r.rid === rid));
  assert.equal((await N.post(deployment("f1"))).body.status, "starting");
  await G.del(s.body.id); await G.alloc.settled();
  assert.equal(active(rig).find((r) => r.rid === rid), undefined);
});

test("legacy unconfigured mode is unchanged and claims no shared coverage", async (t) => {
  const L = await consumer(t, { role: "general", install: false });
  assert.equal(L.backend.allocationInterposed, undefined);
  assert.equal(Object.getOwnPropertyDescriptor(L.backend, "launch").writable, true);
  assert.equal(L.launcher.allocationGated, false);
  assert.equal("allocation" in L.manager.health(), false);
  const r = await L.post(deployment("f2"));
  assert.equal(r.body.status, "starting"); assert.equal(L.host.count("define"), 1);
});

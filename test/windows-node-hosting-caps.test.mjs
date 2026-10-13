// The box owner's hosting caps (windows/node/hosting.mjs) in the Windows node's Host: what it advertises, what it
// claims, and what the isolated backend spawns. The API and the file are windows/node/hosting.test.mjs.
//
// The rules: at the default (no caps file) every figure is the one the node computed before caps existed. A cap only
// ever narrows NEW work - the claim gate, /availability's free figures, and a NEW partition on the isolated backend -
// and lowering one below what is in use stops nothing, gives no lease back, and refuses nothing the box already runs.
// Hyper-V is faked behind the REAL manager (test/helpers/hv-fake-manager.mjs) and Base is a fake JSON-RPC.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeBaseRpc, DEPLOYMENTS, CATALOG, enclaveIdOf } from "./helpers/fake-base-rpc.mjs";
import { REC, DEP, ISOLATED, PLANNED, FakeHost, bootManager, closeManagers } from "./helpers/hv-fake-manager.mjs";
import { servedOwner } from "./helpers/owners.mjs";

const rpc = await fakeBaseRpc();                     // BEFORE chain.mjs loads: it reads BASE_RPCS once
const chain = await import("../windows/node/chain.mjs");
chain.addresses.deployments = DEPLOYMENTS;
chain.addresses.appCatalog = CATALOG;
const { Host } = await import("../windows/node/host.mjs");
after(() => { closeManagers(); rpc.close(); });

const OWNER = "0x29479bf04ed889d46a7afb7f292b9bb26e12647c";
const ENDPOINT = "https://api.enclave.host/t/test";
const ME = enclaveIdOf(ENDPOINT);
const idOf = (c) => "0x" + c.repeat(64);
const A = idOf("a"), B = idOf("b"), C = idOf("c");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ee-caps-"));
const box = (cfg = {}) => new Host({ dir: tmp(), endpoint: ENDPOINT, name: "test", appsEnabled: true, cpuPricePerSec6: 12,
                                      log: () => {}, ...cfg });
const running = (id, cpu, gpu = 0) => ({ id, status: "running", cpuShare: cpu, gpuShare: gpu });
const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-9, `${m ?? ""} ${a} != ${b}`);
const card = { vramBudgetGb: 8, vramFreeGb: 6 };
// a funded public deployment for claimPolicy, from a stranger in market scope (the policy's own shape)
const newDep = (o = {}) => ({ id: idOf("d"), owner: "0x" + "11".repeat(20), appRef: "catalog://0xapp/0", configCid: "", gpuMilli: 0,
  cpuMilli: 100, isPublic: true, active: true, createdAt: 1790000000n, runner: "0x" + "0".repeat(64), leaseUntil: 0n, ...o });
const policy = (h, d) => chain.claimPolicy(d, { ownerAllow: OWNER, enclaveId: h.enclaveId, appsEnabled: true, capacity: h.capacity() });

// ---- defaults ----------------------------------------------------------------------------------------------------
test("DEFAULTS: no caps file is 1.0 on both axes, and every figure is exactly the one computed before caps existed", () => {
  // the two formulas as they stood before this change (host.mjs cpuShareFree / gpuShareFree)
  const oldCpu = (used) => Math.max(0, Math.min(1, 1 - used - 0.25));
  const oldGpu = (sold) => Math.max(0, Math.min(1, 1 - sold, card.vramFreeGb / card.vramBudgetGb));
  for (const set of [[], [[0.1, 0]], [[0.25, 0.1], [0.3, 0.2]], [[0.5, 0.5], [0.4, 0]], [[0.9, 0.9]], [[0.05, 0.15], [0.1, 0.35], [0.15, 0]]]) {
    const h = box({ card: () => card });
    set.forEach(([c, g], i) => h.records.set(idOf(String(i + 1)), running(idOf(String(i + 1)), c, g)));
    const used = set.reduce((a, [c]) => a + c, 0), sold = set.reduce((a, [, g]) => a + g, 0);
    assert.deepEqual(h.hostingCaps(), { cpuShare: 1, gpuShare: 1, paused: false });
    assert.equal(h.cpuShareFree(), oldCpu(used), JSON.stringify(set));
    assert.equal(h.gpuShareFree(), oldGpu(sold), JSON.stringify(set));
    const cap = h.capacity();
    assert.ok(!("cpuCap" in cap) && !("gpuCap" in cap) && !("paused" in cap), "the capacity object has its old shape");
    if (policy(h, newDep({ cpuMilli: 1000 }))) assert.match(policy(h, newDep({ cpuMilli: 1000 })), /left to sell$/, "the old refusal text");
  }
  const h = box();
  assert.equal(fs.existsSync(path.join(h.cfg.dir, "hosting-caps.json")), false, "nothing is written until a slider moves");
  assert.equal(h.capsError, null);
});

// ---- caps narrow what is advertised and claimed -------------------------------------------------------------------
test("caps limit the free figures /availability publishes (maxShare, cpuShareFree, gpuShareFree) and the claim gate, naming the owner's cap", () => {
  const h = box({ card: () => card });
  h.records.set(A, running(A, 0.1, 0.1));
  h.setHostingCaps({ cpuShare: 0.3, gpuShare: 0.5 });
  near(h.cpuShareFree(), 0.2, "cpu: the cap less what is in use");
  near(h.gpuShareFree(), 0.4, "gpu: min(what it was, the cap less what is sold)");
  const cap = h.capacity();
  assert.deepEqual(cap.cpuCap, { offered: 0.3, used: 0.1 }); assert.deepEqual(cap.gpuCap, { offered: 0.5, used: 0.1 });
  assert.equal(policy(h, newDep({ cpuMilli: 200 })), null, "20% fits under a 30% cap with 10% in use");
  assert.equal(policy(h, newDep({ cpuMilli: 250 })),
    "it asks for 25% of a node, and the owner offers 30% of this box's CPU to hosting with 10% of that in use");
  assert.equal(policy(h, newDep({ gpuMilli: 450 })),
    "it asks for 45% of this box's card, and the owner offers 50% of this box's GPU to hosting with 10% of that in use");
  // the node's own reserve still binds above a high cap, and then the cap is not what is named
  h.setHostingCaps({ cpuShare: 0.9, gpuShare: 1 });
  near(h.cpuShareFree(), 0.65, "min(1 - 0.25, 0.9) - 0.1");
  assert.equal(h.capacity().cpuCap, undefined);
  assert.match(policy(h, newDep({ cpuMilli: 700 })), /this box has 65% left to sell$/);
  // appsEnabled off still sells nothing, whatever the caps say
  assert.equal(box({ appsEnabled: false }).cpuShareFree(), 0);
});

test("LOWERING a cap below what is in use evicts nothing, advertises 0 free, and refuses only NEW claims", () => {
  const h = box({ card: () => card });
  h.records.set(A, running(A, 0.3, 0.2)); h.records.set(B, running(B, 0.2, 0));
  const before = JSON.stringify([...h.records.values()]);
  h.setHostingCaps({ cpuShare: 0.2, gpuShare: 0.1 });
  assert.equal(JSON.stringify([...h.records.values()]), before, "no record was touched");
  assert.equal(h.cpuShareFree(), 0); assert.equal(h.gpuShareFree(), 0);
  const v = h.hostingView();
  assert.deepEqual({ caps: v.caps, inUse: v.inUse, free: v.free, served: v.deploymentsServed },
    { caps: { cpuShare: 0.2, gpuShare: 0.1, paused: false }, inUse: { cpuShare: 0.5, gpuShare: 0.2 }, free: { cpuShare: 0, gpuShare: 0 }, served: 2 });
  assert.equal(policy(h, newDep({ cpuMilli: 50 })),
    "it asks for 5% of a node, and the owner offers 20% of this box's CPU to hosting with 50% of that in use");
  // the capacity a hint for a deployment ALREADY here is measured against (host.consider): beside the others, uncapped
  const mine = h.capacity({ exclude: A, capped: false });
  near(mine.cpuShareFree, 0.55, "1 - 0.2 (B) - 0.25"); assert.equal(mine.cpuCap, undefined);
  // use drops below the cap: new work fits again
  h.records.delete(A);
  near(h.cpuShareFree(), 0, "0.2 in use of a 0.2 cap");
  h.records.delete(B);
  near(h.cpuShareFree(), 0.2);
});

test("persistence through the Host: a restarted node reads the caps the tray set; a corrupt file offers nothing new and says so", () => {
  const logs = [];
  const h = box();
  h.setHostingCaps({ cpuShare: 0.45, gpuShare: 0.05 });
  const again = new Host({ dir: h.cfg.dir, endpoint: ENDPOINT, name: "test", appsEnabled: true, log: (m) => logs.push(m) });
  assert.deepEqual(again.hostingCaps(), { cpuShare: 0.45, gpuShare: 0.05, paused: false });
  fs.writeFileSync(path.join(h.cfg.dir, "hosting-caps.json"), "{ half a write");
  const broken = new Host({ dir: h.cfg.dir, endpoint: ENDPOINT, name: "test", appsEnabled: true, log: (m) => logs.push(m) });
  assert.deepEqual(broken.hostingCaps(), { cpuShare: 0, gpuShare: 0, paused: false });
  assert.equal(broken.cpuShareFree(), 0);
  assert.match(broken.hostingView().capsError, /do not parse/);
  assert.ok(logs.some((l) => /hosting-caps\.json\) do not parse/.test(l)), "the node says why it offers nothing new");
  broken.setHostingCaps({ cpuShare: 1, gpuShare: 1 });
  assert.equal(broken.hostingView().capsError, null, "the tray's next set repairs it");
});

test("OFF: nothing new on either axis, every running unit in the drop plan, the caps kept for the resume, and it survives a restart", () => {
  const logs = [];
  const h = box({ card: () => card, log: (m) => logs.push(m) });
  h.records.set(A, running(A, 0.3, 0.2));
  h.setHostingCaps({ cpuShare: 0.8, gpuShare: 0.6, paused: false });
  const open = { cpu: h.cpuShareFree(), gpu: h.gpuShareFree() };
  assert.ok(open.cpu > 0 && open.gpu > 0, "room before the pause");
  const before = JSON.stringify([...h.records.values()]);
  h.setHostingCaps({ ...h.hostingCaps(), paused: true });
  assert.equal(JSON.stringify([...h.records.values()]), before, "nothing is dropped without the owner's confirmation (hosting.mjs asks)");
  assert.deepEqual(h.dropPlan(h.hostingCaps()).map((u) => u.id), [A], "off leaves room for nothing: every running unit is in the plan");
  assert.equal(h.cpuShareFree(), 0); assert.equal(h.gpuShareFree(), 0);
  assert.equal(h.capacity().paused, true);
  assert.equal(policy(h, newDep({ cpuMilli: 50 })), "the owner of this box has paused hosting: it takes no new work until they resume it");
  assert.equal(policy(h, newDep({ cpuMilli: 50, gpuMilli: 100 })), "the owner of this box has paused hosting: it takes no new work until they resume it");
  assert.match(h.capRefusal(B, { cpuShare: 0.05 }), /^not started: the owner of this box has turned hosting off/);
  const v = h.hostingView();
  assert.deepEqual({ caps: v.caps, free: v.free, served: v.deploymentsServed },
    { caps: { cpuShare: 0.8, gpuShare: 0.6, paused: true }, free: { cpuShare: 0, gpuShare: 0 }, served: 1 });
  assert.ok(logs.some((l) => /hosting turned OFF by the owner of this box/.test(l)));
  const again = new Host({ dir: h.cfg.dir, endpoint: ENDPOINT, name: "test", appsEnabled: true, log: () => {} });
  assert.deepEqual(again.hostingCaps(), { cpuShare: 0.8, gpuShare: 0.6, paused: true }, "a restarted node is still paused");
  assert.equal(again.cpuShareFree(), 0);
  h.setHostingCaps({ ...h.hostingCaps(), paused: false });
  assert.deepEqual({ cpu: h.cpuShareFree(), gpu: h.gpuShareFree() }, open, "resumed: exactly the room under the caps again");
  assert.equal(h.capacity().paused, undefined);
  assert.ok(logs.some((l) => /hosting turned ON/.test(l)));
});

test("dropPlan: what lower caps leave no room for - newest first, only units that free an axis that is over, until it fits", () => {
  const h = box({ card: () => card });
  const C = idOf("c"), D = idOf("e");
  h.records.set(A, { ...running(A, 0.3), claimedAt: 1000 });
  h.records.set(B, { ...running(B, 0.2), claimedAt: 2000 });
  h.records.set(C, running(C, 0.1));                                       // adopted after a restart: no claim time
  h.records.set(D, { id: D, status: "failed", cpuShare: 0.5 });            // occupies nothing
  assert.deepEqual(h.dropPlan({ cpuShare: 1, gpuShare: 1 }), [], "it fits: nothing");
  assert.deepEqual(h.dropPlan({ cpuShare: 0.6, gpuShare: 1 }), [], "exactly at use: nothing");
  assert.deepEqual(h.dropPlan({ cpuShare: 0.35, gpuShare: 1 }).map((u) => u.id), [B, A], "0.6 -> 0.4 -> 0.1: the two newest");
  assert.deepEqual(h.dropPlan({ cpuShare: 0.55, gpuShare: 1 }).map((u) => u.id), [B]);
  assert.deepEqual(h.dropPlan({ cpuShare: 0, gpuShare: 1 }).map((u) => u.id), [B, A, C], "everything, newest first");
  // only the GPU over: units with no card share are skipped, whatever their age
  const g = box({ card: () => card });
  g.records.set(A, { ...running(A, 0.1, 0.4), claimedAt: 1000 });
  g.records.set(B, { ...running(B, 0.2, 0), claimedAt: 3000 });
  assert.deepEqual(g.dropPlan({ cpuShare: 1, gpuShare: 0.2 }), [{ id: A, appRef: "", cpuShare: 0.1, gpuShare: 0.4 }]);
  // the Host sets lower caps without a confirmed plan and evicts nothing (the handler is what asks)
  const before = JSON.stringify([...h.records.values()]);
  h.setHostingCaps({ cpuShare: 0.1, gpuShare: 1, paused: false });
  assert.equal(JSON.stringify([...h.records.values()]), before); assert.equal(h.capDrops, undefined);
});

test("the view says what the GPU is for on each backend, and never implies GPU hosting that is not happening", () => {
  const hv = box({ engineRetired: true });
  assert.equal(hv.hostingView().backend, "hv");
  assert.equal(hv.gpuConsumer().consumer, false); assert.match(hv.gpuConsumer().why, /no partition currently holds a masked GPU allocation/);
  // a partition that bought a card share but was spawned with none holds none
  hv.records.set(A, { ...running(A, 0.1, 0.3), isolation: { instance: "hv1" }, partitionGpuShare: 0 });
  assert.deepEqual([hv.hostingView().sold.gpuShare, hv.hostingView().inUse.gpuShare], [0.3, 0]);
  assert.equal(hv.gpuConsumer().consumer, false);
  const legacy = box({ card: () => card });
  assert.equal(legacy.hostingView().backend, "legacy"); assert.equal(legacy.gpuConsumer().consumer, true);
  assert.equal(box({ card: () => null }).gpuConsumer().consumer, false);
});

// ---- the isolated backend: the cap gates a NEW partition, and nothing else ----------------------------------------
const dep = () => ({ appRef: "catalog://0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4",
  leaseUntil: Math.floor(Date.now() / 1000) + 3600, cpuMilli: 100, gpuMilli: 0, isPublic: true, owner: OWNER, configCid: ISOLATED });
function hvBox(port, logs = [], dir = tmp()) {
  const h = new Host({ dir, endpoint: ENDPOINT, name: "test", appsEnabled: true, cpuPricePerSec6: 12, log: (s) => logs.push(s),
                       ramGb: 64, engineRetired: true, isolationManager: `http://127.0.0.1:${port}`, isolationRuntimeId: REC.runtimeId });
  h.cfg.secretsSign = async () => "0x" + "11".repeat(65); h.secrets.set(DEP, {});   // known: no secrets staged
  // the box serves OWNER as its operator (main's owner rule, 4fcb1740: OWNER_WALLET authorizes nothing)
  return servedOwner(h, OWNER);
}

test("hv: a NEW partition that does not fit under the CPU cap is not started, is held with the reason, and starts once it fits", async () => {
  const fake = new FakeHost(); const { port } = await bootManager(fake);
  const logs = []; const h = hvBox(port, logs);
  h.records.set(B, { ...running(B, 0.5), isolation: { instance: "hvB" } });          // another partition, running
  h.setHostingCaps({ cpuShare: 0.55, gpuShare: 1 });
  const held = await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(held.status, "held"); assert.equal(held.capHeld, true);
  assert.equal(held.reason, "isolation: not started: the owner offers 55% of this box's CPU to hosting, 50% of it is in use by running"
    + " and starting partitions, and this one needs 10%; it starts when it fits (nothing running was stopped)");
  assert.equal(fake.running().length, 0, "no VM was started");
  assert.equal(h.hostingView().waitingForCap, 1);
  near(h.hostingView().inUse.cpuShare, 0.5, "a held deployment is not in use");
  await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(logs.filter((l) => /not started: the owner offers/.test(l)).length, 1, "said once, not every pass");
  h.setHostingCaps({ cpuShare: 0.6, gpuShare: 1 });
  const ok = await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(ok.status, "running", ok.reason); assert.equal(ok.capHeld ?? null, null);
  assert.equal(fake.running().length, 1);
  near(h.hostingView().inUse.cpuShare, 0.6);
});

test("hv: a running partition is never stopped by a lower cap; it is adopted every pass, and a forced relaunch brings it back", async () => {
  const fake = new FakeHost(); const { port } = await bootManager(fake);
  const h = hvBox(port);
  assert.equal((await h.ensureApp(DEP, dep(), { version: PLANNED })).status, "running");
  h.setHostingCaps({ cpuShare: 0, gpuShare: 0 });
  for (let i = 0; i < 2; i++) assert.equal((await h.ensureApp(DEP, dep(), { version: PLANNED })).status, "running", "adopted, not held");
  assert.equal(fake.running().length, 1);
  const vmBefore = fake.running()[0].vmId;
  const r = await h.ensureApp(DEP, dep(), { force: true, version: PLANNED });
  assert.equal(r.status, "running", `a relaunch of work this box runs keeps its place: ${r.reason}`);
  assert.equal(fake.running().length, 1); assert.notEqual(fake.running()[0].vmId, vmBefore, "a fresh VM");
});

test("hv: OFF holds a NEW partition; turning off (confirmed) retires EVERY partition and hands their leases back; enforceOff stops a late one", async () => {
  const fake = new FakeHost(); const { port } = await bootManager(fake);
  const logs = []; const h = hvBox(port, logs);
  h.records.set(B, { ...running(B, 0.1), isolation: { instance: "hvB" } });
  h.setHostingCaps({ cpuShare: 1, gpuShare: 1, paused: true });
  const held = await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(held.status, "held"); assert.equal(held.capHeld, true);
  assert.equal(held.reason, "isolation: not started: the owner of this box has turned hosting off");
  assert.equal(fake.running().length, 0, "no VM was started");
  h.setHostingCaps({ cpuShare: 1, gpuShare: 1, paused: false });
  assert.equal((await h.ensureApp(DEP, dep(), { version: PLANNED })).status, "running");
  assert.equal(fake.running().length, 1);
  // off, confirmed: the plan is every unit, newest first, and each partition is retired
  const off = { cpuShare: 1, gpuShare: 1, paused: true };
  const plan = h.dropPlan(off);
  assert.deepEqual(plan.map((u) => u.id), [DEP, B], "everything, the newest first");
  h.setHostingCaps(off, { drop: plan.map((u) => u.id) });
  await h.capDrops;
  assert.equal(fake.running().length, 0, "no partition left: the machine is the owner's again");
  for (const id of [DEP, B]) {
    assert.ok(!Host.occupies(h.records.get(id)), `${id.slice(0, 6)} occupies nothing`);
    assert.match(h.records.get(id).reason || "", /turned hosting off/);
  }
  // a unit that turns up while off (a claim landing as the owner switched) is stopped by the next tick's enforceOff
  h.records.set(C, { ...running(C, 0.1), isolation: { instance: "hvC" } });
  assert.deepEqual(await h.enforceOff(), [C]);
  assert.ok(!Host.occupies(h.records.get(C)));
  assert.deepEqual(await h.enforceOff(), [], "nothing left to stop");
  h.setHostingCaps({ cpuShare: 1, gpuShare: 1, paused: false });
  assert.deepEqual(await h.enforceOff(), [], "on: enforceOff does nothing");
});

test("hv: a confirmed drop retires the newest partition and hands its lease back; the older one keeps running", async () => {
  const fake = new FakeHost(); const { port } = await bootManager(fake);
  const logs = []; const h = hvBox(port, logs);
  h.records.set(B, { ...running(B, 0.5), isolation: { instance: "hvB" } });          // older, running
  assert.equal((await h.ensureApp(DEP, dep(), { version: PLANNED })).status, "running");
  assert.equal(fake.running().length, 1);
  const caps = { cpuShare: 0.5, gpuShare: 1, paused: false };
  const plan = h.dropPlan(caps);
  assert.deepEqual(plan.map((u) => u.id), [DEP], "0.6 in use over a 0.5 cap: the newest goes");
  h.setHostingCaps(caps, { drop: plan.map((u) => u.id) });
  await h.capDrops;
  assert.equal(fake.running().length, 0, "its partition was retired");
  assert.ok(["failed", "released"].includes(h.records.get(DEP).status), h.records.get(DEP).status);
  assert.match(h.records.get(DEP).reason, /lowered its hosting caps to CPU 50%, GPU 100%, below what was in use/);
  assert.equal(h.records.get(B).status, "running", "the older one was not touched");
  near(h.shareUse().cpu, 0.5);
  assert.ok(logs.some((l) => /dropping 1 running deployment\(s\) the owner confirmed, newest first/.test(l)));
});

test("hv: a CAP-HELD deployment is not spawned above the cap by a FORCED ensure - the owner's restart path (enclave-5d)", async () => {
  const fake = new FakeHost(); const { port } = await bootManager(fake);
  const h = hvBox(port);
  h.records.set(B, { ...running(B, 0.5), isolation: { instance: "hvB" } });
  h.setHostingCaps({ cpuShare: 0.55, gpuShare: 1 });
  assert.equal((await h.ensureApp(DEP, dep(), { version: PLANNED })).capHeld, true);
  const forced = await h.ensureApp(DEP, dep(), { force: true, version: PLANNED });
  assert.equal(fake.running().length, 0, "forcing a held deployment is a new spawn, not a relaunch: nothing above the cap");
  assert.equal(forced.capHeld, true); assert.match(forced.reason, /not started: the owner offers 55% of this box's CPU/);
  // through the route itself: restart() passes restartRefusal (active, this box's live lease, the served owner) and still holds
  ledgerRow();
  const viaRoute = await h.restart(DEP, rpc.row.current);
  assert.equal(viaRoute.refused, undefined, viaRoute.reason);
  assert.equal(viaRoute.capHeld, true); assert.equal(fake.running().length, 0);
  // once it fits, the owner's restart starts it
  h.setHostingCaps({ cpuShare: 0.6, gpuShare: 1 });
  assert.equal((await h.restart(DEP, rpc.row.current)).status, "running");
  assert.equal(fake.running().length, 1);
});

test("hv: a node that RESTARTED under a lower cap adopts the partition that is already there (asking the manager only because the cap would refuse)", async () => {
  const fake = new FakeHost(); const { port } = await bootManager(fake);
  const first = hvBox(port);
  assert.equal((await first.ensureApp(DEP, dep(), { version: PLANNED })).status, "running");
  const dir = tmp(); fs.writeFileSync(path.join(dir, "hosting-caps.json"), JSON.stringify({ cpuShare: 0.05 }));
  const restarted = hvBox(port, [], dir);                             // no records: nothing remembered
  assert.equal(restarted.hostingCaps().cpuShare, 0.05);
  const r = await restarted.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(r.status, "running", r.reason); assert.equal(fake.running().length, 1, "adopted, not a second VM");
});

test("hv: the GPU cap never holds a partition spawned with no GPU share (this backend spawns every one with gpuShare 0)", async () => {
  const fake = new FakeHost(); const { port } = await bootManager(fake);
  const h = hvBox(port);
  h.setHostingCaps({ cpuShare: 1, gpuShare: 0 });
  const r = await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(r.status, "running", r.reason);
  assert.equal(h.records.get(DEP).partitionGpuShare, 0);
  assert.equal(h.hostingView().inUse.gpuShare, 0); assert.equal(h.gpuConsumer().consumer, false);
  // the gate itself, for a partition that WOULD hold a GPU share
  assert.match(h.capRefusal(C, { cpuShare: 0, gpuShare: 0.1 }), /owner offers 0% of this box's GPU to hosting/);
  assert.equal(h.capRefusal(C, { cpuShare: 0, gpuShare: 0 }), null);
});

// ---- the tick: a held partition is not renewed, its lease end is honoured, and a resize never evicts --------------
const nowS = () => Math.floor(Date.now() / 1000);
const RENEWAL = (l) => /^renewed |renew failed/.test(l);
function ledgerRow(over = {}) {
  rpc.catalog.current = { cid: REC.cid, version: "4", vramMb: 0, gpuGflops: 0, memMb: 512, cpuGflops: 0, createdAt: 1n, verified: true,
                          yanked: false, ports: "", approval: 0, config: "{}" };
  rpc.row.current = { id: DEP, owner: OWNER, appRef: dep().appRef, ports: "", configCid: ISOLATED, gpuMilli: 0, cpuMilli: 100, appPort: 8080,
    isPublic: true, active: true, createdAt: 1n, rate: 1n, balance6: 0n, spent6: 0n, runner: ME, runnerOperator: "0x" + "00".repeat(20),
    leaseUntil: BigInt(nowS() + 3600), ...over };
}
const onTick = (h) => { h.chainReady = true; h.registered = { endpoint: ENDPOINT, cpuPricePerSec6: 12n }; h.tracked.add(DEP); return h; };

test("tick: a cap-held deployment is NOT renewed inside its window; once the cap allows, it starts and is renewed again", async () => {
  const fake = new FakeHost(); const { port } = await bootManager(fake);
  const logs = []; const h = onTick(hvBox(port, logs));
  h.records.set(B, { ...running(B, 0.5), isolation: { instance: "hvB" } });
  h.setHostingCaps({ cpuShare: 0.5, gpuShare: 1 });
  ledgerRow({ leaseUntil: BigInt(nowS() + 5 * 60) });                      // live, inside RENEW_LEAD_MS
  assert.equal((await h.ensureApp(DEP, dep(), { version: PLANNED })).capHeld, true);
  await h.tick();
  assert.equal(h.records.get(DEP).status, "held"); assert.equal(h.records.get(DEP).capHeld, true);
  assert.deepEqual(logs.filter(RENEWAL), [], "nothing is served, so nothing is renewed");
  assert.equal(fake.running().length, 0);
  h.setHostingCaps({ cpuShare: 1, gpuShare: 1 });
  await h.tick();
  assert.equal(h.records.get(DEP).status, "running"); assert.equal(fake.running().length, 1);
  await h.tick();
  assert.ok(logs.some(RENEWAL), `served again, so renewed again (it fails here, with no key): ${logs.filter(RENEWAL).join(" / ")}`);
});

test("tick: an expired lease still naming this runner is retired without a renewal attempt or permanent block", async () => {
  const fake = new FakeHost(); const { port } = await bootManager(fake);
  const logs = []; const h = onTick(hvBox(port, logs));
  ledgerRow();
  assert.equal((await h.ensureApp(DEP, dep(), { version: PLANNED })).status, "running");
  ledgerRow({ leaseUntil: BigInt(nowS() - 60), balance6: 0n });
  await h.tick();
  assert.equal(h.records.get(DEP).status, "stopped");
  assert.match(h.records.get(DEP).reason, /lease expired/);
  assert.deepEqual(logs.filter(RENEWAL), [], "an expired lease cannot be renewed");
  assert.equal(fake.running().length, 0);
  assert.equal(h.tracked.has(DEP), false);
  assert.equal(h.blocked.has(DEP), false, "funding can make it claimable again");
  assert.ok(!logs.some((l) => /released .* back to the fleet/.test(l)));
});

test("tick: a cap-held deployment whose lease LAPSED is let go locally - not renewed, not blocked, nothing released on chain", async () => {
  const fake = new FakeHost(); const { port } = await bootManager(fake);
  const logs = []; const h = onTick(hvBox(port, logs));
  h.records.set(B, { ...running(B, 0.5), isolation: { instance: "hvB" } });
  h.setHostingCaps({ cpuShare: 0.5, gpuShare: 1 });
  ledgerRow();
  assert.equal((await h.ensureApp(DEP, dep(), { version: PLANNED })).capHeld, true);
  ledgerRow({ leaseUntil: BigInt(nowS() - 60) });
  await h.tick();
  const rec = h.records.get(DEP);
  assert.equal(rec.status, "stopped", rec.reason); assert.match(rec.reason, /room under the owner's hosting cap \(not renewed\)/);
  assert.equal(rec.capHeld ?? null, null); assert.equal(h.tracked.has(DEP), false);
  assert.equal(h.blocked.has(DEP), false, "not blocked: the claim gate lets it back when it fits");
  assert.deepEqual(logs.filter(RENEWAL), []); assert.ok(!logs.some((l) => /released .* back to the fleet/.test(l)));
  assert.equal(fake.running().length, 0);
});

test("tick: under a cap lowered below use, a resize that SHRINKS is applied (never a give-up); one that GROWS past the cap is handed back, naming it", async () => {
  const fake = new FakeHost(); const { port } = await bootManager(fake);
  const logs = []; const h = onTick(hvBox(port, logs));
  ledgerRow({ cpuMilli: 250 });
  assert.equal((await h.ensureApp(DEP, dep(), { version: PLANNED })).status, "running");
  await h.tick();                                                          // first sight: adopts 25% as served
  assert.equal(h.records.get(DEP).servedCpuShare, 0.25);
  h.setHostingCaps({ cpuShare: 0.1, gpuShare: 0 });
  ledgerRow({ cpuMilli: 200 });
  await h.tick();
  assert.equal(h.records.get(DEP).servedCpuShare, 0.2); assert.equal(h.records.get(DEP).status, "running");
  assert.equal(h.blocked.has(DEP), false); assert.equal(fake.running().length, 1);
  assert.ok(!logs.some((l) => /giving up/.test(l)), logs.join(" / "));
  ledgerRow({ cpuMilli: 300 });
  await h.tick();
  assert.match(h.blocked.get(DEP) || "", /resized to 30% of a node and this box has 10% left under the owner's 10% hosting cap/);
});

test("consider(): a hint for a partition this box already runs is accepted under a cap below use (a NEW deployment is refused)", async () => {
  const fake = new FakeHost(); const { port } = await bootManager(fake);
  const h = onTick(hvBox(port));
  ledgerRow();
  assert.equal((await h.ensureApp(DEP, dep(), { version: PLANNED })).status, "running");
  h.records.set(B, { ...running(B, 0.5), isolation: { instance: "hvB" } });
  h.setHostingCaps({ cpuShare: 0.2, gpuShare: 1 });
  const r = await h.consider(DEP);
  assert.equal(r.accepted, true, r.reason); assert.equal(h.records.get(DEP).status, "running"); assert.equal(fake.running().length, 1);
  assert.match(policy(h, newDep({ owner: OWNER, cpuMilli: 50 })), /the owner offers 20% of this box's CPU to hosting with 60% of that in use/);
});

test('Shield marketplace claims require the isolated backend and an unexpired relay window', () => {
 const h=box({engineRetired:true,isolationManager:'http://127.0.0.1:8091',claimScope:'market'});
 h.relayTier='hv-node';
 assert.equal(h.scope(),'owner-only');
 h.shieldMarketUntil=Date.now()+60000;
 assert.equal(h.scope(),'market');
 assert.equal(h.ownerNotServed(newDep()),false);
 h.shieldMarketUntil=Date.now()-1;
 assert.equal(h.scope(),'owner-only');
 h.shieldMarketUntil=Date.now()+60000;h.cfg.engineRetired=false;
 assert.equal(h.scope(),'owner-only');
});

test('a lapsed market window keeps serving what this box runs for MARKET_GRACE_MS; new claims need a live window', () => {
 const h=box({engineRetired:true,isolationManager:'http://127.0.0.1:8091',claimScope:'market'});
 h.relayTier='hv-node';
 assert.equal(h.servingScope(),'owner-only','never opened: no grace');
 h.openShieldMarket(Date.now()+60000);
 assert.equal(h.scope(),'market');assert.equal(h.servingScope(),'market');
 h.openShieldMarket(0);   // the tunnel dropped, or the relay restarted
 assert.equal(h.scope(),'owner-only','a new claim needs a live window');
 assert.equal(h.servingScope(),'market','what runs here is still served');
 assert.equal(h.ownerNotServed(newDep()),false,'a buyer app is not held inside the grace');
 assert.equal(h.restartRefusal(newDep().id,newDep({runner:h.enclaveId,leaseUntil:BigInt(Math.floor(Date.now()/1000)+600)})),null);
 h.shieldMarketSeenUntil=Date.now()-Host.MARKET_GRACE_MS-1;
 assert.equal(h.servingScope(),'owner-only','past the grace: held as before');
 assert.equal(h.ownerNotServed(newDep()),true);
 h.shieldMarketSeenUntil=Date.now();
 for(const [k,v] of [['claimScope','owner-only'],['engineRetired',false]]){
  const old=h.cfg[k];h.cfg[k]=v;assert.equal(h.servingScope(),'owner-only',k);h.cfg[k]=old;
 }
 h.relayTier='';assert.equal(h.servingScope(),'owner-only','no hv-node verdict');
});


test("explicit app RAM budget is independent of CPU reserve, bounded by physical RAM and fail closed", () => {
  const h = box({ ramGb: 112, appRamGb: 64, reservedShare: 0.25 });
  h.records.set(A, { ...running(A, 0.1), memMb: 8192 });
  assert.equal(h.capacity().ramMbPool, 65536);
  assert.equal(h.capacity().ramMbFree, 57344);
  h.cfg.reservedShare = 0.5;
  assert.equal(h.capacity().ramMbPool, 65536);
  assert.equal(h.capacity({ exclude: A }).ramMbFree, 65536);
  h.records.set(B, { ...running(B, 0.1), memMb: 65536 });
  assert.equal(h.capacity().ramMbFree, 0);
  assert.equal(h.records.size, 2, "lower budgets do not destroy running apps");
  for (const v of [-1, NaN, Infinity, '64', 0]) {
    h.cfg.appRamGb = v;
    assert.equal(h.capacity().ramMbPool, 0);
  }
  h.cfg.appRamGb = 200;
  assert.equal(h.capacity().ramMbPool, 112 * 1024);
  delete h.cfg.appRamGb;
  assert.equal(h.capacity().ramMbPool, 56 * 1024);
});

test("the switch through the local API (the tray's call): OFF with apps running is a 409 listing ALL of them, changing nothing; confirmed, it turns off and drops them all", async () => {
  const http = (await import("node:http")).default;
  const { hostingAdminHandler } = await import("../windows/node/hosting.mjs");
  const logs = [];
  const h = box({ card: () => card, log: (m) => logs.push(m) });
  h.records.set(A, { ...running(A, 0.2), claimedAt: 1 }); h.records.set(B, { ...running(B, 0.1), claimedAt: 2 });
  const server = http.createServer(hostingAdminHandler({ host: h, token: "t0k" }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const put = (body) => fetch(`http://127.0.0.1:${server.address().port}/v1/local/hosting`, { method: "PUT",
    headers: { authorization: "Bearer t0k", "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const asked = await put({ paused: true });
  assert.equal(asked.status, 409); assert.equal(asked.json.error, "would_drop");
  assert.deepEqual(asked.json.drop.map((u) => u.id), [B, A], "every app, the newest first - not only what a cap is over by");
  assert.equal(h.hostingCaps().paused, false, "nothing changed without the confirmation");
  assert.equal((await put({ paused: true, drop: [B] })).status, 409, "a partial confirmation turns nothing off");
  const ok = await put({ paused: true, drop: [B, A] });
  assert.equal(ok.status, 200); assert.equal(h.hostingCaps().paused, true);
  assert.deepEqual(ok.json.dropped.map((u) => u.id), [B, A]);
  assert.ok(logs.some((l) => /hosting turned OFF by the owner of this box: .* the 2 deployment\(s\) occupying it are stopped and handed back/.test(l)));
  await h.capDrops.catch(() => {});
  const on = await put({ paused: false });
  assert.equal(on.status, 200); assert.equal(h.hostingCaps().paused, false, "turning on needs no confirmation");
});

// ---- market status: what the tray calls "taking new work" (the network's view, not the switch) --------------------
test("market status: taking new work only while the relay's market window is open", () => {
  const h = box({ claimScope: "market", engineRetired: true, isolationManager: "http://127.0.0.1:1" });
  const why = () => h.marketStatus().why, taking = () => h.marketStatus().taking;
  assert.equal(taking(), false); assert.match(why(), /not connected/);
  h.relayAttached = true; h.relayTier = "hv-node";
  assert.match(why(), /not registered/);
  h.registered = { cpuPricePerSec6: 12 };
  assert.match(why(), /verifying this PC/);                          // attached and registered, witness not verified yet
  h.openShieldMarket(Date.now() + 300_000);
  assert.deepEqual(h.marketStatus(), { taking: true, why: "listed on enclave.host" });
  assert.equal(h.hostingView().market.taking, true);
  h.caps.paused = true;
  assert.deepEqual(h.marketStatus(), { taking: false, why: "hosting is off" });
  h.caps.paused = false; h.relayAttached = false;                   // the tunnel dropped
  assert.match(why(), /not connected/);
  h.relayAttached = true; h.shieldMarketUntil = Date.now() - 1;       // the window lapsed (e.g. after an update)
  assert.equal(taking(), false);
  assert.match(box({ claimScope: "owner-only" }).marketStatus().why, /only its owner's apps/);
});

// ---- follow the book: a ledger cutover moves `deployments`; the node uses the new one without a restart --------------
test("followBook: a moved ledger is adopted (logged once, scan holds cleared), an unchanged book changes nothing", async () => {
  const logs = [];
  const h = box({ log: (m) => logs.push(m) });
  const old = chain.addresses.deployments, NEW = "0x" + "16".repeat(20);
  h.scanHold.set("0xabc", { key: "k", at: Date.now(), ms: 60_000 });
  assert.deepEqual(await h.followBook({ now: 1, resolve: async () => {} }), []);                  // nothing moved
  assert.equal(h.scanHold.size, 1);
  assert.deepEqual(await h.followBook({ now: 2, resolve: async () => {} }), [], "re-read only every BOOK_RECHECK_MS");
  try {
    const moved = await h.followBook({ now: 1 + Host.BOOK_RECHECK_MS, resolve: async () => { chain.addresses.deployments = NEW; } });
    assert.deepEqual(moved, ["deployments"]);
    assert.equal(h.scanHold.size, 0, "rows held against the old ledger are asked again on the new one");
    assert.ok(logs.some((l) => l.includes(`deployments moved ${old} -> ${NEW}`)), logs.join(" / "));
    const failed = await h.followBook({ now: 2 + 2 * Host.BOOK_RECHECK_MS, resolve: async () => { throw new Error("rpc down"); } });
    assert.deepEqual(failed, []);
    assert.equal(chain.addresses.deployments, NEW, "a failed re-read keeps the ledger it has");
  } finally { chain.addresses.deployments = old; }
});

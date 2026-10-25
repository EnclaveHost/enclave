// The isolated backend's app RAM, end to end: the REAL Windows manager (server.mjs, its cpu-share pool and spawn gate)
// over loopback HTTP, behind a FAKED Hyper-V launcher (test/helpers/hv-fake-manager.mjs: no VM is created), read by the
// REAL node (host.mjs capacity, chain.mjs claimPolicy) through its real client. What the node advertises as free app RAM
// must be the pool less what the manager actually reserved: each partition's CPU share of the pool fixed at its spawn,
// held while the manager still owns the record (starting, failed, mid-stop, a stop that failed), and UNKNOWN - never free -
// while the manager cannot read an allocation (a recovered VM) or cannot be read at all. App pool only: VM overhead is
// stated beside it, and host physical RAM is measured by nothing here.
//   run: node --test test/windows-hv-memory-accounting.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fakeBaseRpc, DEPLOYMENTS } from "./helpers/fake-base-rpc.mjs";
import { servedOwner } from "./helpers/owners.mjs";
import { REC, DEP, ISOLATED, PLANNED, FakeHost, FakeLauncher, clientFor } from "./helpers/hv-fake-manager.mjs";
import { Manager, createServer, startManager } from "../windows/vbslike/manager/server.mjs";
import { HyperVPartitionBackend } from "../windows/vbslike/manager/backend.mjs";

const rpc = await fakeBaseRpc();                     // before host.mjs loads: nothing here reaches a public RPC
const chain = await import("../windows/node/chain.mjs");
chain.addresses.deployments = DEPLOYMENTS;
const { Host } = await import("../windows/node/host.mjs");
const servers = [], dirs = [];
after(() => { rpc.close(); for (const s of servers) { s.closeAllConnections?.(); s.close(); } for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const OWNER = "0x29479bf04ed889d46a7afb7f292b9bb26e12647c";
const GiB = 1024, OTHER = "0x" + "ab".repeat(32), THIRD = "0x" + "cd".repeat(32);
const component = Buffer.from(JSON.parse(fs.readFileSync(new URL("../isolation/contract/catalog/derive_vectors.json", import.meta.url), "utf8")).component_hex, "hex");
const body = (name, cpuShare) => ({ derive: REC, name, isPublic: true, hasSecrets: false, cpuShare });

// the launcher states each partition's VM size as wmi-launcher does (align2(max(2048, app + 640))); `gate` holds a start
class SizedLauncher extends FakeLauncher {
  constructor(host, gate = null) { super(host); this.gate = gate; }
  async start(mapping, opts) {
    if (this.gate) await this.gate;
    const h = await super.start(mapping, opts);
    const app = opts.appMemoryMiB ?? mapping.record.policy.memMiB, vm = Math.max(2048, app + 640);
    return { ...h, memory: { policyMiB: mapping.record.policy.memMiB, appMiB: app, vmMiB: vm + (vm % 2) } };
  }
}
async function boot({ poolGiB, fake = new FakeHost(), launcher = new SizedLauncher(fake) } = {}) {
  const manager = new Manager({ runtimeId: REC.runtimeId, fetchComponent: async () => component, ramPoolMiB: poolGiB * GiB,
                                judgeReady: async () => ({ status: "running", transportKeySha256: "cd".repeat(32), checks: { document: { verdict: "monitor-signed" } } }),
                                backend: new HyperVPartitionBackend({ launcher }) });
  await startManager(manager);
  const server = createServer(manager);
  await new Promise((r) => server.listen(0, "127.0.0.1", r)); servers.push(server);
  return { manager, fake, launcher, port: server.address().port, client: clientFor(server.address().port) };
}
const box = (cfg = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-hvmem-")); dirs.push(dir);
  const h = servedOwner(new Host({ dir, endpoint: "https://api.enclave.host/t/test", name: "test", appsEnabled: true, engineRetired: true,
    ramGb: 112, appSlots: 16, cpuPricePerSec6: 12, log: () => {}, ...cfg }), OWNER);
  h.cfg.secretsSign = async () => "0x" + "11".repeat(65); h.secrets.set(DEP, {});
  return h;
};
const dep = (cpuMilli) => ({ appRef: "catalog://0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4",
  leaseUntil: Math.floor(Date.now() / 1000) + 3600, cpuMilli, gpuMilli: 0, isPublic: true, owner: OWNER, configCid: ISOLATED });
const refresh = async (h, client) => h.noteManagerMemory(await client.health());
const row = (cpuMilli) => ({ createdAt: 1n, active: true, owner: OWNER, isPublic: true, cpuMilli, gpuMilli: 0, configCid: ISOLATED,
                             runner: "0x" + "00".repeat(32), leaseUntil: 0n });

// ---- the original finding (root c1f35cf5), through the real ensureApp -> manager spawn -> /health -> capacity path ----
for (const poolGiB of [64, 96]) {
  test(`pool ${poolGiB} GiB: a running 25% partition with a 512 MiB floor leaves pool - 25% free, not pool - 512 MiB`, async () => {
    const m = await boot({ poolGiB });
    const h = box({ isolationManager: `http://127.0.0.1:${m.port}`, isolationRuntimeId: REC.runtimeId, appRamGb: poolGiB });
    const r = await h.ensureApp(DEP, dep(250), { version: PLANNED });
    assert.equal(r.status, "running", r.reason);
    // before any /health that shows it: the node's own claimed unit counts as what its spawn reserves (pending)
    const before = h.capacity();
    assert.equal(before.ramMbFree, poolGiB * GiB * 3 / 4, `pending: ${JSON.stringify(before)}`);
    assert.equal(m.manager.health().memory.reservedMiB, poolGiB * GiB / 4, "the manager reserved the share");
    // after the manager's own statement of it: the same figure, now the manager's reservation (no double count)
    await refresh(h, m.client);
    const cap = h.capacity();
    assert.equal(cap.ramMbFree, poolGiB * GiB * 3 / 4, `the overstatement was ${poolGiB * GiB - 512 - cap.ramMbFree} MiB`);
    assert.equal(cap.ramMbReserved, poolGiB * GiB / 4); assert.equal(cap.ramMbPending, 0);
    assert.equal(cap.ramMeasured, true); assert.equal(cap.ramSource, "partition-manager");
    assert.equal(cap.ramMbPool, poolGiB * GiB, "the configured pool (what pricing reads) is unchanged");
    assert.equal(h.availability().ramMbFree, cap.ramMbFree, "and it is what this box publishes");
    // VM overhead and physical RAM are stated apart from the app pool, never folded into it
    const mem = m.manager.health().memory;
    assert.equal(mem.vmOverheadMiB, 640); assert.equal(mem.physical, "not measured by this manager");
  });
}

// ---- the manager holds a reservation for as long as it owns the record ----
test("starting, failed-but-listed, mid-stop and stop-failed records all hold their reservation; only a confirmed remove frees it", async () => {
  let open; const gate = new Promise((r) => { open = r; });
  const fake = new FakeHost();
  const m = await boot({ poolGiB: 64, fake, launcher: new SizedLauncher(fake, gate) });
  const h = box({ isolationManager: `http://127.0.0.1:${m.port}`, appRamGb: 64 });
  const free = async () => { await refresh(h, m.client); return h.capacity().ramMbFree; };
  // starting: the launch has not returned yet
  const starting = m.manager.spawn(body(OTHER, .25));
  await new Promise((r) => setImmediate(r));
  assert.equal(await free(), 48 * GiB, "a partition still starting already holds its share");
  open(); const a = await starting;
  // failed but still listed (its launch threw: the record stays until DELETE)
  fake.startFails = true;
  const b = await m.manager.spawn(body(THIRD, .25));
  fake.startFails = false;
  assert.equal(b.status, "failed");
  assert.equal(await free(), 32 * GiB, "a failed record the manager still lists still holds its share");
  // a stop that fails leaves the record (and its reservation) in place
  fake.stopFails = true;
  await assert.rejects(m.manager.remove(a.id), /stop failed/);
  assert.equal(await free(), 32 * GiB, "a stop that failed frees nothing");
  fake.stopFails = false;
  // mid-stop: the backend's stop has not returned
  let release; const slow = new Promise((r) => { release = r; });
  const stop = m.launcher.stop.bind(m.launcher);
  m.launcher.stop = async (handle) => { await slow; return stop(handle); };
  const removing = m.manager.remove(a.id);
  assert.equal(await free(), 32 * GiB, "a partition being stopped still holds its share");
  release(); await removing;
  assert.equal(await free(), 48 * GiB, "the confirmed remove frees it");
  await m.manager.remove(b.id);
  assert.equal(await free(), 64 * GiB);
});

// ---- a recovered VM's allocation is unknown: no fictitious free memory ----
test("after a manager restart, a recovered VM makes free app RAM UNKNOWN: nothing is claimed until it is reconciled", async () => {
  const fake = new FakeHost();
  const m1 = await boot({ poolGiB: 64, fake });
  await m1.manager.spawn(body(OTHER, .25));
  const m2 = await boot({ poolGiB: 96, fake });                       // restarted with a changed pool, same VM
  const h = box({ isolationManager: `http://127.0.0.1:${m2.port}`, appRamGb: 96 });
  await refresh(h, m2.client);
  const mem = m2.manager.health().memory;
  assert.equal(mem.known, false); assert.equal(mem.freeMiB, null);
  const cap = h.capacity();
  assert.equal(cap.ramMbFree, 0); assert.equal(cap.ramMeasured, false); assert.match(cap.ramUnknown, /recovered or unattributed/);
  assert.match(chain.claimPolicy(row(100),
    { scope: "owner-only", ownerAllow: h.ownerSet(), enclaveId: h.enclaveId, isolationBackend: h.isolationBackend, appsEnabled: true,
      version: PLANNED, capacity: cap }), /cannot say how much app RAM is free/);
  // a unit that already occupies this box, sized beside the others, is not refused for it
  h.records.set(OTHER, { id: OTHER, status: "running", cpuShare: .25, memMb: 512, isolationRequired: true, isolation: { instance: "x" } });
  assert.equal(h.capacity({ exclude: OTHER }).ramUnknown, undefined);
  // reconciled (the recovered VM removed): known again, and the new pool applies only to new spawns
  for (const v of m2.manager.list()) await m2.manager.remove(v.id);
  h.records.delete(OTHER);
  await refresh(h, m2.client);
  assert.equal(h.capacity().ramMbFree, 96 * GiB);
});

test("an unreadable, malformed or stale manager view advertises no free app RAM (unknown, never all free)", async () => {
  const dead = http.createServer((q, s) => { s.writeHead(500); s.end("{}"); });
  await new Promise((r) => dead.listen(0, "127.0.0.1", r)); servers.push(dead);
  const h = box({ isolationManager: `http://127.0.0.1:${dead.address().port}`, appRamGb: 64 });
  assert.equal(h.capacity().ramUnknown, "the partition manager's RAM has not been read yet");
  await h.isolationVerdict(DEP, dep(250), PLANNED, { envOpts: {}, envRead: true });   // its /health read fails
  assert.equal(h.capacity().ramMbFree, 0); assert.match(h.capacity().ramUnknown, /could not be read/);
  const ok = { rule: "cpu-share", poolMiB: 65536, reservedMiB: 0, known: true, freeMiB: 65536, reservations: [] };
  for (const bad of [{ ...ok, reservedMiB: 1 }, { ...ok, freeMiB: 70000 }, { ...ok, reservations: [{ name: DEP, appMiB: -1 }] }, { ...ok, poolMiB: 0 }, { ...ok, rule: "floor" }]) {
    h.noteManagerMemory({ memory: bad });
    assert.match(h.capacity().ramUnknown, /malformed/, JSON.stringify(bad));
  }
  h.noteManagerMemory({ memory: ok }, Date.now() - Host.MANAGER_MEMORY_MAX_AGE_MS - 1);
  assert.match(h.capacity().ramUnknown, /stale/);
  h.noteManagerMemory({ memory: ok });
  assert.equal(h.capacity().ramMbFree, 64 * GiB, "the control: a fresh well-formed view is used");
});

// ---- what does not change ----
test("a pool changed in config does not resize what the manager holds, and the smaller of the two pools bounds admission", async () => {
  const m = await boot({ poolGiB: 64 });
  await m.manager.spawn(body(OTHER, .25));
  const h = box({ isolationManager: `http://127.0.0.1:${m.port}`, appRamGb: 96 });   // node says 96, the manager runs 64
  await refresh(h, m.client);
  const cap = h.capacity();
  assert.equal(cap.ramMbReserved, 16 * GiB, "the reservation fixed at its spawn, not 25% of 96");
  assert.equal(cap.ramMbManagerPool, 64 * GiB); assert.equal(cap.ramMbPool, 96 * GiB);
  assert.equal(cap.ramMbFree, 48 * GiB);
});

test("a manager with no pool rule, and an in-enclave runtime, keep the floor accounting they had", async () => {
  const h = box({ isolationManager: "http://127.0.0.1:1", appRamGb: 64 });
  h.noteManagerMemory({ backend: "hyperv-partition-per-app" });                     // /health without a memory block
  h.records.set(OTHER, { id: OTHER, status: "running", cpuShare: .25, memMb: 512, isolationRequired: true });
  assert.equal(h.capacity().ramMbFree, 64 * GiB - 512); assert.equal(h.capacity().ramSource, undefined);
  const tee = box({ isolationManager: "http://127.0.0.1:1", enclaveAppAbi: 1, enclaveGb: 8, engineHeldMb: 1024, engineRetired: false });
  tee.records.set(OTHER, { id: OTHER, status: "running", memMb: 512 });
  assert.equal(tee.capacity().ramMbFree, 8 * GiB - 1024 - 512, "in-enclave accounting is untouched");
});

test("claimed-but-not-yet-spawned units count as the share they will reserve; exclude sizes a unit beside the others", async () => {
  const m = await boot({ poolGiB: 64 });
  await m.manager.spawn(body(OTHER, .25));
  const h = box({ isolationManager: `http://127.0.0.1:${m.port}`, appRamGb: 64 });
  h.records.set(OTHER, { id: OTHER, status: "running", cpuShare: .25, memMb: 512, isolationRequired: true, isolation: { instance: "x" } });
  h.records.set(THIRD, { id: THIRD, status: "provisioning", cpuShare: .125, memMb: 512, isolationRequired: true });
  await refresh(h, m.client);
  assert.equal(h.capacity().ramMbPending, 8 * GiB);
  assert.equal(h.capacity().ramMbFree, 40 * GiB);
  assert.equal(h.capacity({ exclude: OTHER }).ramMbFree, 56 * GiB, "its own reservation is not counted against itself");
  assert.equal(h.capacity({ exclude: THIRD }).ramMbFree, 48 * GiB);
});

test("the claim gate refuses a share whose partition would not fit the manager's pool, as the manager would", () => {
  const cap = { slots: 16, slotsFree: 8, cpuShareFree: .75, cpuGflops: 0, ramMbFree: 20 * GiB, ramMbPerShare: 64 * GiB };
  const policy = (cpuMilli, capacity = cap) => chain.claimPolicy(row(cpuMilli),
    { scope: "owner-only", ownerAllow: new Set([OWNER]), enclaveId: "0x" + "00".repeat(32), isolationBackend: "hyperv-partition-per-app",
      appsEnabled: true, version: PLANNED, capacity });
  assert.equal(policy(250), null, "25% of 64 GiB = 16 GiB fits in 20");
  assert.match(policy(500), /reserves 32768 MB of app RAM \(50% of this box's 65536 MB pool\)/);
  assert.equal(policy(500, { ...cap, ramMbPerShare: undefined }), null, "without a manager pool rule only the floor is checked, as before");
});

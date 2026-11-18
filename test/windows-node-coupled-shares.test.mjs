// ONE SHARE, BOTH POOLS (the Hyper-V partition backend), reconciled from the coupled resource-share repair that was
// hand-deployed on nucbox-k11-4 on 2026-10-23 (source and evidence: commit 6dcde7030, node-shares-a5e155ec). The manager
// gives a partition floor(pool x share) MiB and REFUSES a share that gives less than the version's floor
// (memory-share.mjs), so on this backend:
//   - a version's RAM floor is a SHARE requirement (a larger effective share), as its GFLOPS floor is;
//   - the spawn carries the share this box counts, never only the dial (0xc13d4b6a: dialed 1%, counted 2%, held 983 MiB);
//   - a partition sized for another share (an owner's resize either way, or a dial-sized spawn) is relaunched in place
//     when that fits, at most once per window, and until then keeps serving and says so (allocatedShare, reason);
//   - a manager answer with no inventory is not an empty inventory.
// What the manager HOLDS is read as main reads it (its /health memory statement: test/windows-hv-memory-accounting.test.mjs);
// this file covers what that accounting did not: the share itself. Hyper-V is faked behind the REAL manager.
//   run: node --test test/windows-node-coupled-shares.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fakeBaseRpc, DEPLOYMENTS, CATALOG } from "./helpers/fake-base-rpc.mjs";
import { REC, DEP, ISOLATED, PLANNED, FakeHost, FakeLauncher, clientFor, fast } from "./helpers/hv-fake-manager.mjs";
import { servedOwner } from "./helpers/owners.mjs";
import { Manager, createServer, startManager } from "../windows/vbslike/manager/server.mjs";
import { HyperVPartitionBackend } from "../windows/vbslike/manager/backend.mjs";
import { reconcile } from "../windows/node/isolation-lifecycle.mjs";

const rpc = await fakeBaseRpc();                     // BEFORE chain.mjs loads: nothing here reaches a public RPC
const chain = await import("../windows/node/chain.mjs");
chain.addresses.deployments = DEPLOYMENTS;
chain.addresses.appCatalog = CATALOG;
const { Host } = await import("../windows/node/host.mjs");
const servers = [], dirs = [];
after(() => { rpc.close(); for (const s of servers) { s.closeAllConnections?.(); s.close(); } for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const OWNER = "0x29479bf04ed889d46a7afb7f292b9bb26e12647c";
const POOL = 96 * 1024;                              // NODE_APP_RAM_GB 96 (the NucBox, 2026-10-23)
const OTHER = "0x" + "ab".repeat(32);
const component = Buffer.from(JSON.parse(fs.readFileSync(new URL("../isolation/contract/catalog/derive_vectors.json", import.meta.url), "utf8")).component_hex, "hex");
const share = (s) => chain.shareRamMiB?.(POOL, s);

// the launcher states each partition's VM size as wmi-launcher does (align2(max(2048, app + 640)))
class SizedLauncher extends FakeLauncher {
  async start(mapping, opts) {
    const h = await super.start(mapping, opts);
    const app = opts.appMemoryMiB ?? mapping.record.policy.memMiB, vm = Math.max(2048, app + 640);
    return { ...h, memory: { policyMiB: mapping.record.policy.memMiB, appMiB: app, vmMiB: vm + (vm % 2) } };
  }
}
async function boot({ poolMiB = POOL, fake = new FakeHost() } = {}) {
  const manager = new Manager({ runtimeId: REC.runtimeId, fetchComponent: async () => component, ramPoolMiB: poolMiB,
                                judgeReady: async () => ({ status: "running", transportKeySha256: "cd".repeat(32), checks: { document: { ok: true, verdict: "monitor-signed" }, ready: { ok: true } } }),
                                backend: new HyperVPartitionBackend({ launcher: new SizedLauncher(fake) }) });
  await startManager(manager);
  const server = createServer(manager);
  await new Promise((r) => server.listen(0, "127.0.0.1", r)); servers.push(server);
  return { manager, fake, port: server.address().port, client: clientFor(server.address().port) };
}
const box = (cfg = {}, logs = []) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-coupled-")); dirs.push(dir);
  const h = servedOwner(new Host({ dir, endpoint: "https://api.enclave.host/t/test", name: "test", appsEnabled: true, engineRetired: true,
    ramGb: 112, appRamGb: 96, appSlots: 16, gflopsFloorBasis: 1000, cpuPricePerSec6: 12, log: (s) => logs.push(s),
    isolationRuntimeId: REC.runtimeId, ...cfg }), OWNER);
  h.cfg.secretsSign = async () => "0x" + "11".repeat(65); h.secrets.set(DEP, {});
  return h;
};
const on = (m, cfg = {}, logs = []) => box({ isolationManager: `http://127.0.0.1:${m.port}`, ...cfg }, logs);
const refresh = async (h, m) => h.noteManagerMemory(await m.client.health());
const dep = (cpuMilli) => ({ appRef: "catalog://0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4",
  leaseUntil: Math.floor(Date.now() / 1000) + 3600, cpuMilli, gpuMilli: 0, isPublic: true, owner: OWNER, configCid: ISOLATED });
const row = (cpuMilli) => ({ createdAt: 1n, active: true, owner: OWNER, isPublic: true, cpuMilli, gpuMilli: 0, configCid: ISOLATED,
                             runner: "0x" + "00".repeat(32), leaseUntil: 0n });
const ver = (o = {}) => ({ cid: "bafy", version: "1", memMb: 128, cpuGflops: 0, config: "", approval: 1, yanked: false, ...o });
const spawnAt = (m, name, cpuShare) => reconcile({ client: m.client, deployment: { id: name, body: { derive: REC, name, isPublic: true, hasSecrets: false, cpuShare } }, ...fast });
const domains = (m, name = DEP) => m.manager.list().filter((r) => r.name === name);
const running = (id, cpuShare, memMb = 128) => ({ id, status: "running", cpuShare, gpuShare: 0, memMb, isolationRequired: true, isolation: { instance: "hv" + id.slice(2, 10) } });
const NEEDS2 = { ...PLANNED, cpuGflops: 20 };          // 20 GFLOPS of a nominal 1000: 2%, as 0xc13d4b6a's version needs

test("a version's RAM floor is a SHARE requirement where a share sizes RAM, rounded up to whole percents", () => {
  const big = ver({ memMb: 12288 });                   // 12 GiB is 12.5% of 96 GiB -> 13%
  assert.equal(chain.effectiveCpuShare({ cpuMilli: 10 }, big, 1000, POOL), 0.13);
  assert.equal(chain.effectiveCpuShare({ cpuMilli: 250 }, big, 1000, POOL), 0.25, "a dial above the need is kept");
  assert.equal(chain.effectiveCpuShare({ cpuMilli: 10 }, big, 1000), 0.01, "no pool (not coupled): RAM is not a share");
  assert.equal(chain.effectiveCpuShare({ cpuMilli: 10 }, ver({ cpuGflops: 20 }), 1000), 0.02, "the GFLOPS floor, as before");
  assert.equal(chain.effectiveCpuShare({ cpuMilli: 10 }, ver({ cpuGflops: 20, memMb: 4096 }), 1000, POOL), 0.05, "the larger of the two floors");
  // the publisher's coreless cpuFallback raises the floor the same way
  assert.equal(chain.effectiveCpuShare({ cpuMilli: 10 }, ver({ memMb: 512, config: JSON.stringify({ cpuFallback: { memMb: 8192 } }) }), 1000, POOL), 0.09);
  assert.equal(chain.shareRamMiB(POOL, 0.01), 983);
  // what the share gives always covers the floor (the manager's own check), and it is the smallest whole percent that does
  for (const memMb of [128, 512, 983, 984, 1024, 4097, 30000, 98304]) {
    const s = chain.effectiveCpuShare({ cpuMilli: 10 }, ver({ memMb }), 1000, POOL);
    assert.ok(chain.shareRamMiB(POOL, s) >= memMb, `${memMb} MiB -> ${s}`);
    assert.ok(s === 0.01 || chain.shareRamMiB(POOL, s - 0.01) < memMb, `${memMb} MiB: ${s} is the smallest whole percent`);
  }
});

test("the node counts that share only on the partition backend, against the pool its manager states", () => {
  const big = ver({ memMb: 12288 });
  const h = box({ isolationManager: "http://127.0.0.1:9" });
  assert.equal(h.sharePoolMiB(), POOL, "before the manager is read: this node's own NODE_APP_RAM_GB");
  assert.equal(h.cpuShareOf("x", { cpuMilli: 10 }, big), 0.13);
  // the manager's pool is the one its partitions are sized from
  h.noteManagerMemory({ memory: { rule: "cpu-share", poolMiB: 65536, reservedMiB: 0, known: true, freeMiB: 65536, reservations: [] } });
  assert.equal(h.sharePoolMiB(), 65536);
  assert.equal(h.cpuShareOf("x", { cpuMilli: 10 }, big), 0.19, "12288 of 65536 MiB is 18.75%");
  // an unreadable answer does not forget it
  h.noteManagerMemory(null);
  assert.equal(h.sharePoolMiB(), 65536);
  // a manager with no pool rule sizes partitions by their floors: RAM is not a share there (windows-hv-memory-accounting)
  h.noteManagerMemory({ backend: "hyperv-partition-per-app" });
  assert.equal(h.sharesCoupled(), false);
  assert.equal(h.cpuShareOf("x", { cpuMilli: 10 }, big), 0.01);
  // no partition manager, or apps in the enclave: untouched
  const plain = box();
  assert.equal(plain.sharesCoupled(), false);
  assert.equal(plain.cpuShareOf("x", { cpuMilli: 10 }, big), 0.01);
  const tee = box({ isolationManager: "http://127.0.0.1:9", enclaveAppAbi: 1, enclaveGb: 8, engineHeldMb: 1024, engineRetired: false });
  assert.equal(tee.sharePoolMiB(), 0);
});

test("the share a box has left reads as a reader sees it: 1 - 0.58 - 0.25 is 17%, not 16.999...%", () => {
  const h = box();
  h.records.set(OTHER, { id: OTHER, status: "running", cpuShare: 0.58, memMb: 128 });
  assert.equal(h.cpuShareFree(), 0.17);
  assert.equal(Math.floor(h.cpuShareFree() * 100), 17, "the fleet row's floor reads 17, not 16");
  assert.equal(h.capacity().cpuShareFree, 0.17);
});

test("the claim gate sizes a new lease at the share its version needs here, in CPU and in the RAM that share reserves", () => {
  const cap = { slots: 16, slotsFree: 8, cpuShareFree: 0.75, cpuGflops: 1000, ramMbFree: 60000, ramMbPerShare: POOL };
  const policy = (cpuMilli, version, capacity = cap) => chain.claimPolicy(row(cpuMilli),
    { scope: "owner-only", ownerAllow: new Set([OWNER]), enclaveId: "0x" + "00".repeat(32), isolationBackend: "hyperv-partition-per-app",
      appsEnabled: true, version, capacity });
  const big = ver({ memMb: 12288 });
  assert.equal(policy(10, big), null, "13% fits");
  assert.match(policy(10, big, { ...cap, cpuShareFree: 0.12 }),
    /takes 13% of this box \(its version needs 12288 MB of RAM, 13% of this box\) and this box has 12% left/);
  // the RAM that 13% reserves (12779 MiB), not only the 12288 MiB floor, must be free
  assert.match(policy(10, big, { ...cap, ramMbFree: 12500 }),
    /its partition reserves 12779 MB of app RAM \(13% of this box's 98304 MB pool\) \(its version needs 12288 MB of RAM, 13% of this box\) and this box has 12500 MB left/);
  // each floor is named only when it is what raises the share
  assert.match(policy(10, ver({ cpuGflops: 20 }), { ...cap, cpuShareFree: 0.01 }), /takes 2% of this box \(its version needs 20 GFLOPS, 2% of this box\)/);
  assert.match(policy(10, ver({ cpuGflops: 130, memMb: 12288 }), { ...cap, cpuShareFree: 0.01 }), /\(its version needs 130 GFLOPS and 12288 MB of RAM, 13% of this box\)/);
  // without a manager pool rule only the floor is checked, as before
  assert.equal(policy(10, big, { ...cap, ramMbPerShare: undefined, cpuShareFree: 0.01 }), null);
});

test("the spawn carries the share this box counts: a GFLOPS need above the dial (0xc13d4b6a) sizes the partition too", async () => {
  const m = await boot();
  const h = on(m);
  const r = await h.ensureApp(DEP, dep(10), { version: NEEDS2 });
  assert.equal(r.status, "running", r.reason);
  assert.equal(h.records.get(DEP).cpuShare, 0.02, "what the node counts");
  assert.deepEqual([domains(m)[0].memory.cpuShare, domains(m)[0].memory.appMiB], [0.02, 1966], "what the partition was given");
});

test("a version whose RAM floor exceeds what its dial buys is spawned at the share that covers it, not refused by the manager", async () => {
  const m = await boot({ poolMiB: 16 * 1024 });        // 1% of 16 GiB is 163 MiB, under the vector's 512 MiB floor
  const h = on(m, { appRamGb: 16 });
  assert.ok(PLANNED.memMb > 163, "the fixture's floor is above the dial");
  const want = Math.ceil(PLANNED.memMb / (16 * 1024) * 100) / 100;
  const r = await h.ensureApp(DEP, dep(10), { version: PLANNED });
  assert.equal(r.status, "running", r.reason);
  assert.equal(h.records.get(DEP).cpuShare, want);
  assert.deepEqual([domains(m)[0].memory.cpuShare, domains(m)[0].memory.appMiB], [want, Math.floor(16 * 1024 * want + 1e-7)]);
  assert.ok(domains(m)[0].memory.appMiB >= PLANNED.memMb);
});

test("a partition spawned at its 1% DIAL below the 2% this box counts is relaunched once, in place, at 2%", async () => {
  const m = await boot();
  const r0 = await spawnAt(m, DEP, 0.01);              // what the node did before: spawned at the dial
  assert.equal(r0.instance.memory.appMiB, 983);
  const logs = [];
  const h = on(m, {}, logs);
  h.records.set(DEP, { id: DEP, status: "running", isolation: { instance: r0.instance.id } });
  const r = await h.ensureApp(DEP, dep(10), { version: NEEDS2 });
  assert.equal(r.status, "running", `${r.reason} | ${logs.join(" / ")}`);
  assert.deepEqual([r.reason, r.allocatedShare, r.cpuShare], [null, null, 0.02]);
  const now = domains(m);
  assert.equal(now.length, 1, "exactly one partition");
  assert.notEqual(now[0].id, r0.instance.id, "the 1% partition was retired first");
  assert.deepEqual([now[0].memory.cpuShare, now[0].memory.appMiB], [0.02, 1966]);
  assert.ok(logs.some((l) => /was given 983 MiB for a 1% share and this deployment takes 2%; relaunching it in place/.test(l)), logs.join(" / "));
  // the next pass adopts it: no second relaunch
  assert.equal((await h.ensureApp(DEP, dep(10), { version: NEEDS2 })).status, "running");
  assert.equal(domains(m)[0].id, now[0].id);
  assert.equal(m.fake.starts, 2);
});

test("when the counted share does NOT fit it keeps serving at what it has, explicitly pending and counted, until it fits", async () => {
  const m = await boot();
  const r0 = await spawnAt(m, DEP, 0.01);
  const h = on(m);
  h.records.set(DEP, { id: DEP, status: "running", isolation: { instance: r0.instance.id } });
  // the box has sold everything but 1% beside it (and the manager holds the other tenant's partition)
  await spawnAt(m, OTHER, 0.74);
  h.records.set(OTHER, running(OTHER, 0.74));
  for (let pass = 0; pass < 2; pass++) {
    const r = await h.ensureApp(DEP, dep(10), { version: NEEDS2 });
    assert.equal(r.status, "running", r.reason);
    assert.match(r.reason, /was given 983 MiB for a 1% share and this deployment takes 2%; not relaunched yet: 2% \(1966 MiB\) does not fit beside the others \(1% of this box and \d+ MiB left\)/);
    assert.equal(r.allocatedShare, 0.01, "pending, not done");
    assert.equal(domains(m)[0].id, r0.instance.id, "the same partition keeps serving");
  }
  // counted at 2% meanwhile (what it holds, and the growth it waits for): the room it will take is not sold
  await refresh(h, m);
  const cap = h.capacity();
  assert.equal(cap.ramMbReserved, 983 + share(0.74));
  assert.equal(cap.ramMbPending, 1966 - 983);
  assert.equal(cap.ramMbFree, POOL - share(0.74) - 1966);
  // the other tenant leaves: the next pass repairs it
  await m.client.remove(domains(m, OTHER)[0].id);
  h.records.delete(OTHER);
  const r = await h.ensureApp(DEP, dep(10), { version: NEEDS2 });
  assert.deepEqual([r.status, r.reason, r.allocatedShare], ["running", null, null]);
  assert.deepEqual([domains(m)[0].memory.cpuShare, domains(m)[0].memory.appMiB], [0.02, 1966]);
});

test("an owner's resize is served at the new share's RAM both ways (bounded: once per window, only when it fits)", async () => {
  const m = await boot();
  const h = on(m);
  const pass = (cpuMilli) => h.ensureApp(DEP, dep(cpuMilli), { version: PLANNED });
  const held = () => domains(m)[0].memory.appMiB;
  const open = () => { h.records.get(DEP).shareRelaunchAt = Date.now() - Host.SHARE_RELAUNCH_MIN_MS - 1; };
  assert.equal((await pass(100)).status, "running");
  assert.equal(held(), 9830);
  // UP to 20%: relaunched in place (before: held by isolation-lifecycle as "a different RAM share", and not served)
  let r = await pass(200);
  assert.deepEqual([r.status, r.reason, r.allocatedShare, held()], ["running", null, null, 19660]);
  // UP to 30% inside the window: pending at 20%, said, counted at 30%; once the window passes, relaunched
  r = await pass(300);
  assert.equal(r.status, "running");
  assert.match(r.reason, /not relaunched yet: it was relaunched for its share \d+ s ago/);
  await refresh(h, m);
  assert.deepEqual([r.allocatedShare, held(), h.capacity().ramMbReserved + h.capacity().ramMbPending], [0.2, 19660, 29491]);
  open();
  r = await pass(300);
  assert.deepEqual([r.reason, r.allocatedShare, held()], [null, null, 29491]);
  // DOWN to 5%: the owner's downsize is applied too (pending inside the window, counted at what it still holds)
  r = await pass(50);
  assert.match(r.reason, /takes 5%; not relaunched yet: it was relaunched/);
  await refresh(h, m);
  assert.deepEqual([r.allocatedShare, held(), h.capacity().ramMbReserved + h.capacity().ramMbPending], [0.3, 29491, 29491]);
  open();
  r = await pass(50);
  assert.deepEqual([r.status, r.reason, r.allocatedShare, held()], ["running", null, null, 4915]);
  // UP to 90%: beyond the 75% this box sells; the 5% partition keeps serving, pending, and says why
  open();
  r = await pass(900);
  assert.equal(r.status, "running", r.reason);
  assert.match(r.reason, /not relaunched yet: 90% \(88473 MiB\) does not fit beside the others \(75% of this box and 98304 MiB left\)/);
  assert.deepEqual([r.allocatedShare, held()], [0.05, 4915]);
  assert.equal(m.fake.starts, 4, "one spawn and three relaunches: 20%, 30%, 5%");
});

test("a resize this box cannot size (unknown manager) waits instead of giving the lease back (pinned in source)", () => {
  const src = fs.readFileSync(new URL("../windows/node/host.mjs", import.meta.url), "utf8");
  const wait = src.indexOf("if (ramUnknown) {"), giveUp = src.indexOf("return await this.#giveUp(id, `it was resized to");
  assert.ok(wait > 0 && giveUp > wait, "the unknown-manager wait precedes the resize give-ups");
  assert.match(src.slice(wait, giveUp), /waits: \$\{ramUnknown\}`\);\n\s+return;\n\s+\}/);
  assert.match(src, /ramUnknown = pool > 0 && cpu > wasCpu \? this\.managerRamUnknown\(\) : null;/);
});

test("a manager answer with no inventory is not an EMPTY inventory (real HTTP)", async () => {
  let vmsBody = { vms: null };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(req.url === "/vms" ? vmsBody : {}));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r)); servers.push(server);
  const client = clientFor(server.address().port);
  for (const bad of [{ vms: null }, {}, { vms: {} }, { vms: "[]" }, null, 7]) {
    vmsBody = bad;
    await assert.rejects(client.list(), (e) => e.kind === "protocol" && /GET \/vms: the answer carries no vms list/.test(e.message), JSON.stringify(bad));
    await assert.rejects(client.findByName(DEP), /carries no vms list/, "and a deployment is not 'absent' on it");
  }
  vmsBody = { vms: [] };
  assert.deepEqual(await client.list(), []);
  vmsBody = [];
  assert.deepEqual(await client.list(), []);
});

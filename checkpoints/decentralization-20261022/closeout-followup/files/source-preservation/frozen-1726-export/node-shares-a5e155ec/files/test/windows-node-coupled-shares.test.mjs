// ONE SHARE, BOTH POOLS (the Hyper-V partition backend). The user's rule (2026-10-23): "1% share should be 1% of both ram
// and compute. The numbers must be tied together." The manager already gives a partition floor(NODE_APP_RAM_GB x share)
// MiB (memory-share.mjs); the node advertised and admitted RAM as the pool less catalog FLOORS, so the NucBox published
// 17% of its CPU beside 79.8 of 96 GB "free" while the manager held 57% of the pool. What this holds to:
//   - free is ONE fraction: owner reserve and cap bind CPU and RAM alike, and ramMbFree = floor(pool x cpuShareFree);
//   - every deployment holds the larger of what its share buys and what the manager says its partitions hold;
//   - the version's RAM floor is a share requirement (a larger effective share, or a refusal), never discounted RAM;
//   - the spawn carries the share the node counts, and a partition sized for another share (an owner's resize either
//     way, or 0xc13d4b6a's dial-sized spawn) is relaunched in place when that fits, else stays explicitly pending;
//   - an unread, malformed, stale, recovered, pool-less or other-pool manager sells nothing new, and refuses nothing here.
// Hyper-V is faked behind the REAL (installed) manager; Base is a fake JSON-RPC.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fakeBaseRpc, DEPLOYMENTS, CATALOG } from "./helpers/fake-base-rpc.mjs";
import { REC, DEP, ISOLATED, PLANNED, FakeHost, FakeLauncher, clientFor, fast, closeManagers } from "./helpers/hv-fake-manager.mjs";
import { servedOwner } from "./helpers/owners.mjs";
import { Manager, createServer, startManager } from "../windows/vbslike/manager/server.mjs";
import { HyperVPartitionBackend } from "../windows/vbslike/manager/backend.mjs";
import { reconcile } from "../windows/node/isolation-lifecycle.mjs";

const rpc = await fakeBaseRpc();                     // BEFORE chain.mjs loads: it reads BASE_RPCS once
const chain = await import("../windows/node/chain.mjs");
chain.addresses.deployments = DEPLOYMENTS;
chain.addresses.appCatalog = CATALOG;
const { Host } = await import("../windows/node/host.mjs");
const servers = [];
after(() => { closeManagers(); for (const s of servers) { s.closeAllConnections?.(); s.close(); } rpc.close(); });

const OWNER = "0x29479bf04ed889d46a7afb7f292b9bb26e12647c";
const POOL = 96 * 1024;                              // NODE_APP_RAM_GB 96 (the NucBox, 2026-10-23)
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ee-coupled-"));
const box = (cfg = {}, logs = []) => servedOwner(new Host({ dir: tmp(), endpoint: "https://api.enclave.host/t/test", name: "test",
  appsEnabled: true, cpuPricePerSec6: 12, log: (s) => logs.push(s), ramGb: 112, appRamGb: 96, gflopsFloorBasis: 1000, appSlots: 32,
  isolationManager: "http://127.0.0.1:9", isolationRuntimeId: REC.runtimeId, ...cfg }), OWNER);
const W = { id: "hvwitness", name: "shield-readiness-v1", status: "running", memory: null, policy: { cpuPercent: 100, memMiB: 256, vcpus: 1 } };
const vm = (name, share, extra = {}) => ({ id: "hv" + name.slice(2, 10), name, status: "running",
  memory: { rule: "cpu-share", poolMiB: POOL, cpuShare: share, appMiB: chain.shareRamMiB(POOL, share) }, policy: { memMiB: 128, vcpus: 1, cpuPercent: 100 }, ...extra });
const view = (vms, o = {}) => ({ at: Date.now(), memory: { rule: "cpu-share", poolMiB: POOL }, vms, ...o });
const running = (id, cpuShare, memMb = 128) => ({ id, status: "running", cpuShare, gpuShare: 0, memMb, isolationRequired: true, isolation: { instance: "hv" + id.slice(2, 10) } });
const idOf = (c) => "0x" + c.repeat(64);
const idN = (i) => "0x" + i.toString(16).padStart(2, "0").repeat(32);
// a public deployment of the box owner's, as claimPolicy reads it
const newDep = (o = {}) => ({ id: idOf("d"), owner: OWNER, appRef: "catalog://0xapp/0", configCid: ISOLATED, gpuMilli: 0,
  cpuMilli: 10, isPublic: true, active: true, createdAt: 1790000000n, runner: "0x" + "0".repeat(64), leaseUntil: 0n, ...o });
const ver = (o = {}) => ({ cid: "bafy", version: "1", memMb: 128, cpuGflops: 0, config: "", approval: 1, yanked: false, ...o });
const admit = (h, d, v = ver(), o = {}) => h.claimRefusal(d, { version: v, capacity: h.capacity({ exclude: d.id, ...o }), appsEnabled: true });
const tied = (h, o) => assert.equal(h.capacity(o).ramMbFree, chain.shareRamMiB(POOL, h.cpuShareFree(o)), "RAM free is the free share of the pool");

// The nine apps and the manager's view at 2026-10-23T15:58:09Z (work/nucbox-ram96-20261023/share-accounting-live.json).
const LIVE = [
  ["0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33", 0.02, 1024, 0.02],
  ["0x38f368d67995676e0bbe48ebbc1d18a643bb314942374b44e1e52239a1cd215c", 0.01, 128, 0.01],
  ["0xe64f7cba307e2d97485bde356d75564ccb74c5e31c272b5ab3349abfe122569b", 0.25, 12288, 0.25],
  ["0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a", 0.01, 128, 0.01],
  ["0xa77d0c577c1ca48510ff72545f9e050dc7d1fc9c6d1129f056494a5190cb8371", 0.01, 128, 0.01],
  ["0xc13d4b6a613ba277e9a8559adb76b2f60394ef16649f7a623e8a7a6c4f097681", 0.02, 512, 0.01],   // dialed 1%, version needs 2%
  ["0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c", 0.04, 256, 0.04],
  ["0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238", 0.21, 2048, 0.21],
  ["0xa69dcbbae66ac6ca71784d56209b1039142480ec97e0c8a3fd9cc658d969ed77", 0.01, 128, 0.01],
];
const live = () => {
  const h = box();
  for (const [id, share, memMb] of LIVE) h.records.set(id, running(id, share, memMb));
  h.managerView = view([W, ...LIVE.map(([id, , , m]) => vm(id, m))]);
  return h;
};

test("the live NucBox: 17% of its CPU is 17% of its 96 GiB app pool, not 79.8 GB beside 16%", () => {
  const h = live();
  const cap = h.capacity();
  assert.equal(h.cpuShareFree(), 0.17, "1 - 0.58 sold - 0.25 reserve, as a reader sees it");
  assert.equal(Math.floor(h.cpuShareFree() * 100), 17, "the fleet row's floor reads 17, not 16");
  assert.equal(cap.cpuShareFree, 0.17);
  assert.equal(cap.ramMbFree, 16711, "floor(98304 x 0.17)");
  assert.notEqual(cap.ramMbFree, 98304 - 16640, "never the pool less catalog floors (79.8 GB)");
  assert.equal(cap.sharePoolMiB, POOL);
  assert.equal(cap.ramMbHeld, 57015, "0xc13d4b6a counts at the 2% this box counts (1966 MiB), not the 983 its partition was given");
  assert.equal(cap.ramUnknown, undefined);
  assert.equal(h.availability().ramGbFree, 16.3);
  tied(h);
});

test("1% buys 1% of both pools: each admission takes a hundredth of the CPU and floor(pool/100) MiB together", () => {
  const h = live();
  assert.equal(admit(h, newDep()), null);
  for (let i = 0; i < 17; i++) h.records.set(idN(i), running(idN(i), 0.01));
  assert.equal(h.cpuShareFree(), 0, "seventeen more 1% apps sell the last 17%");
  assert.equal(h.capacity().ramMbFree, 0);
  assert.match(admit(h, newDep()), /takes 1% of this box and this box has 0% left/);
  h.records.delete(idN(0));
  assert.equal(h.cpuShareFree(), 0.01);
  assert.equal(h.capacity().ramMbFree, 983, "floor(98304 x 0.01)");
  tied(h);
  assert.equal(admit(h, newDep()), null);
});

test("the owner's reserve and cap bind the same fraction of RAM as of CPU", () => {
  const h = box();
  h.managerView = view([]);
  assert.equal(h.cpuShareFree(), 0.75, "a quarter stays for the owner");
  assert.equal(h.capacity().ramMbFree, 73728, "...a quarter of the RAM pool too, not 96 GiB");
  h.caps = { cpuShare: 0.3, gpuShare: 1, paused: false };
  h.records.set(idOf("a"), running(idOf("a"), 0.1));
  assert.equal(h.cpuShareFree(), 0.2);
  assert.equal(h.capacity().ramMbFree, chain.shareRamMiB(POOL, 0.2));
  tied(h);
  assert.match(admit(h, newDep({ cpuMilli: 250 })), /owner offers 30% of this box's CPU to hosting with 10% of that in use/);
  // what is already here is measured without the cap (a lowered cap takes nothing back)
  assert.equal(h.cpuShareFree({ capped: false }), 0.65);
  tied(h, { capped: false });
  h.caps = { cpuShare: 1, gpuShare: 1, paused: false };
  h.cfg.reservedShare = 0.5;
  assert.equal(h.cpuShareFree(), 0.4);
  assert.equal(h.capacity().ramMbFree, chain.shareRamMiB(POOL, 0.4));
});

test("a version's RAM floor is a SHARE requirement: a larger effective share, or a refusal - never discounted RAM", () => {
  const h = live();
  const big = ver({ memMb: 12288 });                   // RISC Box: 12 GiB is 12.5% of 96 GiB -> 13%
  assert.equal(chain.effectiveCpuShare({ cpuMilli: 10 }, big, 1000, POOL), 0.13);
  assert.equal(chain.effectiveCpuShare({ cpuMilli: 250 }, big, 1000, POOL), 0.25, "a dial above the need is kept");
  assert.equal(chain.effectiveCpuShare({ cpuMilli: 10 }, big, 1000), 0.01, "no pool (not coupled): RAM is not a share");
  assert.equal(h.cpuShareOf("x", { cpuMilli: 10 }, big), 0.13, "the node counts the share the version needs");
  assert.equal(admit(h, newDep(), big), null, "13% fits in 17%");
  h.records.set(idOf("b"), running(idOf("b"), 0.05));
  assert.match(admit(h, newDep(), big), /takes 13% of this box \(its version needs 12288 MB of RAM, 13% of this box\) and this box has 12% left/);
  // the publisher's coreless cpuFallback raises the floor the same way
  const fb = ver({ memMb: 512, config: JSON.stringify({ cpuFallback: { memMb: 8192 } }) });
  assert.equal(chain.effectiveCpuShare({ cpuMilli: 10 }, fb, 1000, POOL), 0.09);
  // floors round UP to whole percents, and what the share gives always covers the floor
  for (const memMb of [128, 512, 983, 984, 1024, 4097, 30000, 98304]) {
    const s = chain.effectiveCpuShare({ cpuMilli: 10 }, ver({ memMb }), 1000, POOL);
    assert.ok(chain.shareRamMiB(POOL, s) >= memMb, `${memMb} MiB -> ${s}`);
    assert.ok(s === 0.01 || chain.shareRamMiB(POOL, s - 0.01) < memMb, `${memMb} MiB: ${s} is the smallest whole percent`);
  }
});

test("what the manager actually holds counts: a partition larger than its share, a failed one, a deployment not tracked here", () => {
  const h = live();
  // 0xd979 was resized down to 1% but its partition still holds the 10% it was spawned with
  const d979 = LIVE[3][0];
  h.managerView = view([W, ...LIVE.map(([id, , , m]) => vm(id, id === d979 ? 0.10 : m)),
                        vm(idOf("f"), 0.03, { status: "failed" })]);      // ended, not yet removed, untracked here
  assert.equal(h.capacity().ramMbHeld, 57015 - 983 + 9830 + 2949);
  // 73728 sellable less 68811 held: 4917 MiB, the share it is (rounded down to a millionth)
  assert.equal(h.cpuShareFree(), Math.floor((73728 - 68811) / POOL * 1e6) / 1e6, "17% less the 9% the larger partition holds over its share, less the failed 3%");
  tied(h);
  // the manager's own pool admits the readiness witness too: it binds only when the manager's pool is the tighter one
  const full = box({ reservedShare: 0 });
  full.managerView = view([W, vm(idOf("a"), 0.99)]);
  assert.equal(full.capacity().ramMbFree, POOL - chain.shareRamMiB(POOL, 0.99) - 256 - 1, "less the witness, as the manager counts it (rounded down to a millionth of a share)");
});

test("unknown is not room: unread, failed, stale, recovered, unsized or other-pool managers sell nothing new and take nothing away", () => {
  const cases = [
    [null, /has not been read yet/],
    [{ at: Date.now(), error: "connect ECONNREFUSED" }, /could not be read: connect ECONNREFUSED/],
    [view([], { at: Date.now() - Host.MANAGER_VIEW_MAX_AGE_MS - 1000 }), /last read \d+ s ago/],
    [view([{ ...vm(idOf("a"), 0.1), recovered: true }]), /recovered from an earlier manager/],
    [view([{ id: "hvx", name: null, unattributed: true, recovered: true }]), /recovered from an earlier manager/],
    [view([{ ...vm(idOf("a"), 0.1), memory: null, policy: null }]), /states no RAM reservation/],
    // an ordinary partition with no share reservation is NOT its catalog floor (only the readiness witness is)
    [view([{ ...vm(idOf("a"), 0.1), memory: null, policy: { memMiB: 8192 } }]), /partition hv[a]+ states no RAM reservation/],
    [view([{ ...vm(idOf("a"), 0.1), memory: { rule: "floor", appMiB: 8192 } }]), /states no RAM reservation/],
    [view([{ ...vm(idOf("a"), 0.1), memory: { rule: "cpu-share", appMiB: "8192" } }]), /states no RAM reservation/],
    [view([{ ...W, name: "not-the-witness" }]), /states no RAM reservation/],
    // a manager that states no share pool (an older pool-less one), another rule, or a malformed pool
    [view([], { memory: null }), /states no cpu-share RAM pool/],
    [view([], { memory: { rule: "floor", poolMiB: POOL } }), /states no cpu-share RAM pool/],
    [view([], { memory: { rule: "cpu-share", poolMiB: "98304" } }), /states no cpu-share RAM pool/],
    [view([], { memory: { rule: "cpu-share", poolMiB: 95 * 1024 } }), /sizes partitions from a 97280 MiB pool and this node sells a 98304 MiB one/],
  ];
  for (const [mv, why] of cases) {
    const h = box();
    h.records.set(idOf("a"), running(idOf("a"), 0.1));
    h.managerView = mv;
    const cap = h.capacity();
    assert.equal(h.cpuShareFree(), 0, String(why));
    assert.equal(cap.ramMbFree, 0);
    assert.match(cap.ramUnknown, why);
    assert.match(admit(h, newDep()), /cannot establish how much of its app RAM pool is reserved/);
    // a deployment already here is measured uncapped and is never refused for it
    const here = h.capacity({ exclude: idOf("a"), capped: false });
    assert.equal(here.ramUnknown, undefined);
    assert.equal(here.cpuShareFree, 0.75);
    assert.equal(admit(h, newDep({ id: idOf("a") }), ver(), { capped: false }), null);
  }
  // an isolation box with no app RAM pool sells nothing at all
  const none = box({ appRamGb: 0 });
  none.managerView = view([]);
  assert.equal(none.cpuShareFree(), 0);
  assert.match(none.capacity().ramUnknown, /no app RAM pool/);
});

test("a box that is NOT coupled (no partition manager) keeps its RAM budget and only gains the rounding", () => {
  const h = new Host({ dir: tmp(), endpoint: "https://api.enclave.host/t/test", name: "t", appsEnabled: true, cpuPricePerSec6: 12,
                       log: () => {}, ramGb: 112, appRamGb: 96 });
  h.records.set(idOf("a"), { id: idOf("a"), status: "running", cpuShare: 0.58, memMb: 16640 });
  assert.equal(h.sharesCoupled(), false);
  assert.equal(h.cpuShareFree(), 0.17);
  assert.equal(h.capacity().ramMbFree, POOL - 16640);
  assert.equal(h.capacity().sharePoolMiB, undefined);
  assert.equal(h.cpuShareOf("x", { cpuMilli: 10 }, ver({ memMb: 12288 })), 0.01);
});

// ---- the real manager, over a faked Hyper-V, at NODE_APP_RAM_GB 96 ------------------------------------------------
async function bootPooled(host) {
  const component = Buffer.from(JSON.parse(fs.readFileSync(new URL("../isolation/contract/catalog/derive_vectors.json", import.meta.url), "utf8")).component_hex, "hex");
  const manager = new Manager({ judgeReady: (async () => ({ status: "running", transportKeySha256: "cd".repeat(32),
    checks: { document: { ok: true, verdict: "monitor-signed" }, ready: { ok: true } } })), runtimeId: REC.runtimeId,
    fetchComponent: async () => component, ramPoolMiB: POOL, backend: new HyperVPartitionBackend({ launcher: new FakeLauncher(host) }) });
  await startManager(manager);
  const server = createServer(manager);
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  servers.push(server);
  return { manager, port: server.address().port };
}
const dep = (cpuMilli) => ({ appRef: "catalog://0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4",
  leaseUntil: Math.floor(Date.now() / 1000) + 3600, cpuMilli, gpuMilli: 0, isPublic: true, owner: OWNER, configCid: ISOLATED });
const noSecrets = (h) => { h.cfg.secretsSign = async () => "0x" + "11".repeat(65); h.secrets.set(DEP, {}); };
const NEEDS2 = { ...PLANNED, cpuGflops: 20 };          // 20 GFLOPS of a nominal 1000: 2%, as 0xc13d4b6a's 0.1.5 needs
const domains = (m) => m.manager.list().filter((r) => r.name === DEP);

test("the manager is read over its real API, and a claim re-reads it", async () => {
  const fh = new FakeHost();
  const m = await bootPooled(fh);
  const h = box({ isolationManager: `http://127.0.0.1:${m.port}` });
  assert.equal(h.managerView, null);
  await reconcile({ client: clientFor(m.port), deployment: { id: DEP, body: { derive: REC, name: DEP, isPublic: true, hasSecrets: false, cpuShare: 0.25 } }, ...fast });
  const v = await h.refreshManagerView();
  assert.deepEqual(v.memory, { rule: "cpu-share", poolMiB: POOL });
  assert.equal(v.vms[0].memory.appMiB, 24576);
  assert.equal(h.capacity().ramMbHeld, 24576, "held by the manager, untracked by this node: counted");
  assert.equal(h.cpuShareFree(), 0.5);
  // consider() re-reads a view older than MANAGER_VIEW_CLAIM_AGE_MS before it sizes a claim (pinned in source)
  const src = fs.readFileSync(new URL("../windows/node/host.mjs", import.meta.url), "utf8");
  assert.match(src, /if \(this\.sharesCoupled\(\) && !\(Date\.now\(\) - \(this\.managerView\?\.at \|\| 0\) < Host\.MANAGER_VIEW_CLAIM_AGE_MS && !this\.managerView\?\.error\)\)\n\s+await this\.refreshManagerView\(\);\n\s+const refuse = await this\.walletPolicyRefusal/);
  assert.match(src, /if \(this\.sharesCoupled\(\)\) await this\.refreshManagerView\(\);\n\s+\/\/ SERVING FIRST/);
  // a manager that stops answering is unknown at the next read
  const dead = box({ isolationManager: "http://127.0.0.1:9" });
  await dead.refreshManagerView();
  assert.match(dead.capacity().ramUnknown, /could not be read/);
});

test("c13d4b6a: a partition spawned at its 1% DIAL below the 2% this box counts is relaunched once, in place, at 2%", async () => {
  const fh = new FakeHost();
  const m = await bootPooled(fh);
  // what the installed node did: spawned at the dial
  const r0 = await reconcile({ client: clientFor(m.port), deployment: { id: DEP, body: { derive: REC, name: DEP, isPublic: true, hasSecrets: false, cpuShare: 0.01 } }, ...fast });
  assert.equal(r0.instance.memory.appMiB, 983);
  const logs = [];
  const h = box({ isolationManager: `http://127.0.0.1:${m.port}` }, logs);
  h.records.set(DEP, { id: DEP, status: "running", isolation: { instance: r0.instance.id } });
  noSecrets(h);
  await h.refreshManagerView();
  const r = await h.ensureApp(DEP, dep(10), { version: NEEDS2 });
  assert.equal(r.status, "running", `${r.reason} | ${logs.join(" / ")}`);
  assert.equal(r.reason, null);
  assert.equal(r.allocatedShare, null);
  assert.equal(r.cpuShare, 0.02);
  const now = domains(m);
  assert.equal(now.length, 1, "exactly one partition");
  assert.notEqual(now[0].id, r0.instance.id, "the 1% partition was retired first");
  assert.deepEqual([now[0].memory.cpuShare, now[0].memory.appMiB], [0.02, 1966]);
  assert.ok(logs.some((l) => /was given 983 MiB for a 1% share and this deployment takes 2%; relaunching it in place/.test(l)), logs.join(" / "));
  // the next pass adopts it: no second relaunch
  await h.refreshManagerView();
  assert.equal((await h.ensureApp(DEP, dep(10), { version: NEEDS2 })).status, "running");
  assert.equal(domains(m)[0].id, now[0].id);
  assert.equal(fh.starts, 2);
});

test("c13d4b6a when 2% does NOT fit: it keeps serving at 1%, explicitly pending (allocatedShare, reason) every pass, until it fits", async () => {
  const fh = new FakeHost();
  const m = await bootPooled(fh);
  const r0 = await reconcile({ client: clientFor(m.port), deployment: { id: DEP, body: { derive: REC, name: DEP, isPublic: true, hasSecrets: false, cpuShare: 0.01 } }, ...fast });
  const h = box({ isolationManager: `http://127.0.0.1:${m.port}` });
  h.records.set(DEP, { id: DEP, status: "running", isolation: { instance: r0.instance.id } });
  noSecrets(h);
  // the box has sold everything but 1% beside it (and the manager holds the other tenant's partition)
  await reconcile({ client: clientFor(m.port), deployment: { id: idOf("b"), body: { derive: REC, name: idOf("b"), isPublic: true, hasSecrets: false, cpuShare: 0.74 } }, ...fast });
  h.records.set(idOf("b"), running(idOf("b"), 0.74));
  for (let pass = 0; pass < 2; pass++) {
    await h.refreshManagerView();
    const r = await h.ensureApp(DEP, dep(10), { version: NEEDS2 });
    assert.equal(r.status, "running", r.reason);
    assert.match(r.reason, /was given 983 MiB for a 1% share and this deployment takes 2%; not relaunched yet: 1966 MiB does not fit beside the others \(983 MiB left\)/);
    assert.equal(r.allocatedShare, 0.01, "pending, not done");
    assert.equal(domains(m)[0].id, r0.instance.id);
  }
  assert.equal(h.capacity().ramMbHeld, 1966 + chain.shareRamMiB(POOL, 0.74), "counted at 2% meanwhile: nothing is oversold");
  // the other tenant leaves: the next pass repairs it
  await clientFor(m.port).remove(m.manager.list().find((x) => x.name === idOf("b")).id);
  h.records.delete(idOf("b"));
  await h.refreshManagerView();
  const r = await h.ensureApp(DEP, dep(10), { version: NEEDS2 });
  assert.equal(r.reason, null);
  assert.equal(r.allocatedShare, null);
  assert.deepEqual([domains(m)[0].memory.cpuShare, domains(m)[0].memory.appMiB], [0.02, 1966]);
});

test("an owner's resize is served at the new share's RAM both ways (bounded: once per window, only when it fits)", async () => {
  const fh = new FakeHost();
  const m = await bootPooled(fh);
  const h = box({ isolationManager: `http://127.0.0.1:${m.port}` });
  noSecrets(h);
  h.records.set(DEP, { id: DEP, status: "provisioning", isolationRequired: true });
  const pass = async (cpuMilli) => { await h.refreshManagerView(); return await h.ensureApp(DEP, dep(cpuMilli), { version: PLANNED }); };
  const held = () => domains(m)[0].memory.appMiB;
  const open = () => { h.records.get(DEP).shareRelaunchAt = Date.now() - Host.SHARE_RELAUNCH_MIN_MS - 1; };
  assert.equal((await pass(100)).status, "running");
  assert.equal(held(), 9830);
  // UP to 20%: relaunched in place
  let r = await pass(200);
  assert.deepEqual([r.status, r.reason, r.allocatedShare, held()], ["running", null, null, 19660]);
  // UP to 30% inside the window: pending at 20%, said, counted at 30%; once the window passes, relaunched
  r = await pass(300);
  assert.equal(r.status, "running");
  assert.match(r.reason, /not relaunched yet: it was relaunched for its share \d+ s ago/);
  assert.deepEqual([r.allocatedShare, held(), h.capacity().ramMbHeld], [0.2, 19660, 29491]);
  open();
  r = await pass(300);
  assert.deepEqual([r.reason, r.allocatedShare, held()], [null, null, 29491]);
  // DOWN to 5%: the owner's downsize is applied too (pending inside the window, counted at what it still holds)
  r = await pass(50);
  assert.match(r.reason, /takes 5%; not relaunched yet: it was relaunched/);
  assert.deepEqual([r.allocatedShare, held(), h.capacity().ramMbHeld], [0.3, 29491, 29491]);
  open();
  r = await pass(50);
  assert.deepEqual([r.status, r.reason, r.allocatedShare, held()], ["running", null, null, 4915]);
  // UP to 90%: beyond the 75% this box sells; the 5% partition keeps serving, pending, and says why
  open();
  r = await pass(900);
  assert.equal(r.status, "running", r.reason);
  assert.match(r.reason, /not relaunched yet: 88473 MiB does not fit beside the others \(73728 MiB left\)/);
  assert.deepEqual([r.allocatedShare, held()], [0.05, 4915]);
  // ...and an unknown manager is not a fit either
  h.managerView = { at: Date.now(), error: "connect ECONNREFUSED" };
  r = await h.ensureApp(DEP, dep(400), { version: PLANNED });
  assert.match(r.reason, /not relaunched yet: what the manager holds is unknown/);
  assert.equal(fh.starts, 4, "one spawn and three relaunches: 20%, 30%, 5%");
});

test("a resize this box cannot size (unknown manager) waits instead of giving the lease back (pinned in source)", () => {
  const src = fs.readFileSync(new URL("../windows/node/host.mjs", import.meta.url), "utf8");
  const wait = src.indexOf("if (cpu > wasCpu && capped.ramUnknown) {"), giveUp = src.indexOf("return await this.#giveUp(id, `it was resized to");
  assert.ok(wait > 0 && giveUp > wait, "the unknown-manager wait precedes the resize give-up");
  assert.match(src.slice(wait, giveUp), /waits: \$\{capped\.ramUnknown\}`\);\n\s+return;\n\s+\}/);
});

test("a malformed manager answer is an unread manager, never an empty inventory (real HTTP)", async () => {
  let vmsBody = { vms: null };
  const health = { memory: { rule: "cpu-share", poolMiB: POOL } };
  const server = http.createServer((req, res) => {
    const body = req.url === "/health" ? health : req.url === "/vms" ? vmsBody : {};
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const port = server.address().port;
  const h = box({ isolationManager: `http://127.0.0.1:${port}` });
  for (const bad of [{ vms: null }, {}, { vms: {} }, { vms: "[]" }, null, 7]) {
    vmsBody = bad;
    await assert.rejects(clientFor(port).list(), /GET \/vms: the answer carries no vms list/, JSON.stringify(bad));
    await h.refreshManagerView();
    assert.match(h.capacity().ramUnknown, /could not be read: GET \/vms: the answer carries no vms list/, JSON.stringify(bad));
    assert.equal(h.cpuShareFree(), 0);
  }
  // the same manager answering properly is read, and sells
  vmsBody = { vms: [] };
  await h.refreshManagerView();
  assert.equal(h.cpuShareFree(), 0.75);
  // a client whose list() is not a list (a mock, or a future client) is unread too
  await h.refreshManagerView({ health: async () => health, list: async () => ({ vms: [] }) });
  assert.match(h.capacity().ramUnknown, /its \/vms answer is not a list/);
  await h.refreshManagerView({ health: async () => null, list: async () => [] });
  assert.match(h.capacity().ramUnknown, /its \/health answer is not an object/);
  // a /health with no share pool: read, and still unknown
  delete health.memory;
  await h.refreshManagerView();
  assert.match(h.capacity().ramUnknown, /states no cpu-share RAM pool/);
});

test("the spawn carries the share this box counts, so the manager's RAM floor check never refuses a counted share", async () => {
  const fh = new FakeHost();
  const m = await bootPooled(fh);
  const h = box({ isolationManager: `http://127.0.0.1:${m.port}` });
  noSecrets(h);
  h.records.set(DEP, { id: DEP, status: "provisioning", isolationRequired: true });
  await h.refreshManagerView();
  const r = await h.ensureApp(DEP, dep(10), { version: { ...PLANNED, memMb: 4096 } });
  assert.equal(r.status, "running", r.reason);
  assert.equal(h.records.get(DEP).cpuShare, 0.05, "4096 MiB of a 98304 MiB pool is 4.2%: 5%");
  assert.deepEqual([domains(m)[0].memory.cpuShare, domains(m)[0].memory.appMiB], [0.05, 4915]);
});

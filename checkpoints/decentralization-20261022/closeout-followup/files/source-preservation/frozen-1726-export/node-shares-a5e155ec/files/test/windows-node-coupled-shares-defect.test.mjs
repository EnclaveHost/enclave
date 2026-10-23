// The 2026-10-23 NucBox share defect, reproduced through APIs the INSTALLED node already has (capacity, cpuShareFree,
// availability, claimRefusal, ensureApp over the real manager), so the same file runs against the installed source and
// the fix: every test here fails on the former and passes on the latter. The fix's own suite is
// test/windows-node-coupled-shares.test.mjs. (`managerView` is what the fix sizes against; the installed node ignores it.)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeBaseRpc, DEPLOYMENTS, CATALOG } from "./helpers/fake-base-rpc.mjs";
import { REC, DEP, ISOLATED, PLANNED, FakeHost, FakeLauncher, clientFor, fast, closeManagers } from "./helpers/hv-fake-manager.mjs";
import { servedOwner } from "./helpers/owners.mjs";
import { Manager, createServer, startManager } from "../windows/vbslike/manager/server.mjs";
import { HyperVPartitionBackend } from "../windows/vbslike/manager/backend.mjs";
import { reconcile } from "../windows/node/isolation-lifecycle.mjs";

const rpc = await fakeBaseRpc();
const chain = await import("../windows/node/chain.mjs");
chain.addresses.deployments = DEPLOYMENTS;
chain.addresses.appCatalog = CATALOG;
const { Host } = await import("../windows/node/host.mjs");
const servers = [];
after(() => { closeManagers(); for (const s of servers) { s.closeAllConnections?.(); s.close(); } rpc.close(); });

const OWNER = "0x29479bf04ed889d46a7afb7f292b9bb26e12647c";
const POOL = 98304;
const ram = (share) => Math.floor(POOL * share + 1e-7);          // memory-share.mjs
const box = (cfg = {}) => servedOwner(new Host({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ee-defect-")),
  endpoint: "https://api.enclave.host/t/test", name: "test", appsEnabled: true, cpuPricePerSec6: 12, log: () => {},
  ramGb: 112, appRamGb: 96, gflopsFloorBasis: 1000, appSlots: 16, isolationManager: "http://127.0.0.1:9",
  isolationRuntimeId: REC.runtimeId, ...cfg }), OWNER);
const W = { id: "hvwitness", name: "shield-readiness-v1", status: "running", memory: null, policy: { memMiB: 256 } };
const vm = (name, share, o = {}) => ({ id: "hv" + name.slice(2, 10), name, status: "running", policy: { memMiB: 128 },
  memory: { rule: "cpu-share", poolMiB: POOL, cpuShare: share, appMiB: ram(share) }, ...o });
// 15:58:09Z: [id, node cpuShare, catalog memMb, the share its partition was spawned with]
const LIVE = [["0x7ae4", 0.02, 1024, 0.02], ["0x38f3", 0.01, 128, 0.01], ["0xe64f", 0.25, 12288, 0.25], ["0xd979", 0.01, 128, 0.01],
              ["0xa77d", 0.01, 128, 0.01], ["0xc13d", 0.02, 512, 0.01], ["0x59f1", 0.04, 256, 0.04], ["0xef51", 0.21, 2048, 0.21],
              ["0xa69d", 0.01, 128, 0.01]].map(([p, ...r]) => [p + p.slice(2).repeat(15), ...r]);
const live = () => {
  const h = box();
  for (const [id, cpuShare, memMb] of LIVE)
    h.records.set(id, { id, status: "running", cpuShare, gpuShare: 0, memMb, isolationRequired: true, isolation: { instance: "hv" + id.slice(2, 10) } });
  h.managerView = { at: Date.now(), memory: { rule: "cpu-share", poolMiB: POOL }, vms: [W, ...LIVE.map(([id, , , s]) => vm(id, s))] };
  return h;
};
const newDep = (o = {}) => ({ id: "0x" + "d".repeat(64), owner: OWNER, appRef: "catalog://0xapp/0", configCid: ISOLATED, gpuMilli: 0,
  cpuMilli: 10, isPublic: true, active: true, createdAt: 1790000000n, runner: "0x" + "0".repeat(64), leaseUntil: 0n, ...o });
const ver = (o = {}) => ({ cid: "bafy", version: "1", memMb: 128, cpuGflops: 0, config: "", approval: 1, yanked: false, ...o });

test("DEFECT 1: the live box advertises 79.8 GB of RAM beside 16% of its CPU; one share must be one fraction of both", () => {
  const h = live();
  assert.equal(Math.floor(h.cpuShareFree() * 100), 17, "1 - 0.58 - 0.25 floors to 16 in the fleet row");
  assert.equal(h.capacity().ramMbFree, ram(0.17), "RAM free must be the free 17% of the pool, not pool less floors");
  assert.equal(h.availability().ramGbFree, 16.3);
});

test("DEFECT 2: a 20 GiB app dialed at 1% is admitted against 'independent' RAM; it needs 21% and only 17% is free", () => {
  const h = live();
  const why = h.claimRefusal(newDep(), { version: ver({ memMb: 20480 }), capacity: h.capacity({ exclude: newDep().id }), appsEnabled: true });
  assert.notEqual(why, null, "admitted: the manager would then refuse 983 MiB < 20480 at spawn, after the claim");
  assert.match(why, /21%/);
});

test("DEFECT 3: a partition manager holding recovered (unknown) reservations is still sold as free", () => {
  const h = live();
  h.managerView.vms.push({ ...vm("0x" + "f".repeat(64), 0.1), recovered: true });
  assert.equal(h.cpuShareFree(), 0, "unknown reservations must not be sold");
  assert.notEqual(h.claimRefusal(newDep(), { version: ver(), capacity: h.capacity({ exclude: newDep().id }), appsEnabled: true }), null);
});

async function bootPooled(host) {
  const component = Buffer.from(JSON.parse(fs.readFileSync(new URL("../isolation/contract/catalog/derive_vectors.json", import.meta.url), "utf8")).component_hex, "hex");
  const manager = new Manager({ judgeReady: async () => ({ status: "running", transportKeySha256: "cd".repeat(32),
    checks: { document: { ok: true, verdict: "monitor-signed" }, ready: { ok: true } } }), runtimeId: REC.runtimeId,
    fetchComponent: async () => component, ramPoolMiB: POOL, backend: new HyperVPartitionBackend({ launcher: new FakeLauncher(host) }) });
  await startManager(manager);
  const server = createServer(manager);
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  servers.push(server);
  return { manager, port: server.address().port };
}
const dep = (cpuMilli) => ({ appRef: "catalog://0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4",
  leaseUntil: Math.floor(Date.now() / 1000) + 3600, cpuMilli, gpuMilli: 0, isPublic: true, owner: OWNER, configCid: ISOLATED });
const ready = async (m) => {
  const h = box({ isolationManager: `http://127.0.0.1:${m.port}` });
  h.cfg.secretsSign = async () => "0x" + "11".repeat(65); h.secrets.set(DEP, {});
  await h.refreshManagerView?.();
  return h;
};
const mine = (m) => m.manager.list().filter((r) => r.name === DEP);

test("DEFECT 4 (0xc13d4b6a): a partition is spawned at the 1% DIAL while the node counts the 2% its version needs", async () => {
  const m = await bootPooled(new FakeHost());
  const h = await ready(m);
  h.records.set(DEP, { id: DEP, status: "provisioning", isolationRequired: true });
  const r = await h.ensureApp(DEP, dep(10), { version: { ...PLANNED, cpuGflops: 20 } });
  assert.equal(r.status, "running", r.reason);
  assert.equal(h.records.get(DEP).cpuShare, 0.02, "what the node counts");
  assert.equal(mine(m)[0].memory.appMiB, ram(0.02), "what the partition was given");
});

test("DEFECT 5: a version whose RAM floor exceeds its dial is claimed, then refused by the manager at spawn", async () => {
  const m = await bootPooled(new FakeHost());
  const h = await ready(m);
  h.records.set(DEP, { id: DEP, status: "provisioning", isolationRequired: true });
  const r = await h.ensureApp(DEP, dep(10), { version: { ...PLANNED, memMb: 4096 } });
  assert.equal(r.status, "running", r.reason);
  assert.equal(mine(m)[0].memory.appMiB, ram(0.05));
});

test("DEFECT 6: an owner's resize stops the app being served (held: 'different RAM share') instead of relaunching it", async () => {
  const m = await bootPooled(new FakeHost());
  const h = await ready(m);
  h.records.set(DEP, { id: DEP, status: "provisioning", isolationRequired: true });
  assert.equal((await h.ensureApp(DEP, dep(100), { version: PLANNED })).status, "running");
  await h.refreshManagerView?.();
  const r = await h.ensureApp(DEP, dep(200), { version: PLANNED });
  assert.equal(r.status, "running", r.reason);
  assert.equal(mine(m)[0].memory.appMiB, ram(0.2));
});

// The node's isolated-domain paths through host.mjs itself (#isolationReconcile, #retireIsolated, #giveUp, the forced
// relaunch and the share accounting), against the REAL manager, the real node client and the real lifecycle. Only
// Hyper-V (test/helpers/hv-fake-manager.mjs) and Base (test/helpers/fake-base-rpc.mjs: nothing reaches a public RPC)
// are faked. From enclave-d1's independent reviews of dad939e9 and d626da4e (its reviewer's probes E1/E2, H1-H8, P1).
//
// THE RULE every test here checks: a lease is given back, and a domain counted gone, only when the domain is KNOWN
// gone. A VM the node cannot name, a manager that cannot answer, and a DELETE that failed all keep the lease.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fakeBaseRpc, DEPLOYMENTS } from "./helpers/fake-base-rpc.mjs";
import { REC, DEP, deployment, ISOLATED, PLANNED, FakeHost, bootManager, restartManager, clientFor, ledger, fast,
         recoveredOnManager, closeManagers } from "./helpers/hv-fake-manager.mjs";
import { reconcile, retire } from "../windows/node/isolation-lifecycle.mjs";

// Base is faked BEFORE host.mjs (and so chain.mjs) loads: a give-up's release read goes here, never to a public RPC
const rpc = await fakeBaseRpc();
const chain = await import("../windows/node/chain.mjs");
chain.addresses.deployments = DEPLOYMENTS;
const { Host } = await import("../windows/node/host.mjs");
after(() => { closeManagers(); rpc.close(); });

const dep = () => ({ appRef: "catalog://0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4",
  leaseUntil: Math.floor(Date.now() / 1000) + 3600, cpuMilli: 100, gpuMilli: 0, isPublic: true,
  owner: "0x29479bf04ed889d46a7afb7f292b9bb26e12647c", configCid: ISOLATED });
// each box gets its own state directory: blocked and tracked deployments persist there, and one test's give-up must
// not be read by the next
const box = (port, logs = []) => new Host({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ee-iso-host-")),
  endpoint: "https://api.enclave.host/t/test", name: "test", appsEnabled: true, cpuPricePerSec6: 12,
  log: (s) => logs.push(s), isolationManager: `http://127.0.0.1:${port}`, isolationRuntimeId: REC.runtimeId });
const YANKED = { yanked: true, cid: "bafy", version: 4 };
const FORCED = { cid: "bafy", version: 4, memMb: 512 };
const noSecrets = (h) => { h.cfg.secretsSign = async () => "0x" + "11".repeat(65); h.secrets.set(DEP, {}); };   // known: none staged

test("UPGRADE (E1): a VM an older manager marked only as ours is UNKNOWN to the node: reconcile holds, retire by name releases nothing", async () => {
  const host = new FakeHost();
  const m1 = await bootManager(host, 0, { legacyNotes: true });
  const c = clientFor(m1.port);
  assert.equal((await reconcile({ client: c, deployment, ...fast })).action, "spawned");
  await restartManager(m1, host);
  const led = ledger();
  const r = await reconcile({ client: c, deployment, ledger: led, ...fast });
  assert.equal(r.action, "held", r.reason); assert.equal(r.leaseFree, false);
  assert.equal(host.running().length, 1, "no second VM");
  const rr = await retire({ client: c, deployment, ledger: led });
  assert.equal(rr.removed, false, rr.reason); assert.deepEqual(led.released, []);
  assert.equal(host.running().length, 1);
});

test("UPGRADE (E2): retire(instanceId) of that VM after the new manager surveyed never confirms it gone", async () => {
  const host = new FakeHost();
  const m1 = await bootManager(host, 0, { legacyNotes: true });
  const c = clientFor(m1.port);
  const r1 = await reconcile({ client: c, deployment, ...fast });
  await restartManager(m1, host);
  const led = ledger();
  const rr = await retire({ client: c, deployment, ledger: led, instanceId: r1.instance.id });
  assert.equal(rr.removed, false, rr.reason); assert.deepEqual(led.released, []);
  assert.equal(host.running().length, 1);
});

test("a HELD recovered domain is recorded by id (finding 3), apart from the record that routes traffic", async () => {
  const { host, m2, instanceId } = await recoveredOnManager();
  const logs = [];
  const h = box(m2.port, logs);
  h.records.set(DEP, { id: DEP, status: "provisioning" });            // a restarted node
  noSecrets(h);
  const r = await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(r.status, "provisioning", `${r.reason} | ${logs.join(" / ")}`);
  assert.match(r.reason, /recovered from Hyper-V/);
  assert.equal(h.records.get(DEP).isolationHeld, instanceId, "the held instance is not recorded");
  assert.equal(h.records.get(DEP).isolation ?? null, null, "a held domain must not be routed to");
  assert.equal(host.running().length, 1);
});

test("forced relaunch with the instance KNOWN (H1): the old VM is removed and confirmed before anything else", async () => {
  const { host, m2, instanceId, vmId } = await recoveredOnManager();
  const h = box(m2.port);
  h.records.set(DEP, { id: DEP, status: "provisioning", isolation: { instance: instanceId } });
  noSecrets(h);
  const r = await h.ensureApp(DEP, dep(), { force: true, version: PLANNED });
  assert.ok(!host.running().some((x) => x.vmId === vmId), "the old VM still runs");
  assert.equal(host.running().length, 1, "exactly one VM: the fresh one");
  assert.equal(r.status, "running", r.reason);
});

test("forced relaunch whose DELETE fails (H2): nothing new starts, the old VM keeps the lease", async () => {
  const { host, m2, instanceId } = await recoveredOnManager();
  host.stopFails = true;
  const h = box(m2.port);
  h.records.set(DEP, { id: DEP, status: "provisioning", isolation: { instance: instanceId } });
  const r = await h.ensureApp(DEP, dep(), { force: true, version: FORCED });
  assert.equal(r.status, "provisioning"); assert.match(r.reason, /could not be confirmed gone/);
  assert.equal(host.running().length, 1);
});

test("forced relaunch against a manager that cannot survey Hyper-V (H3): nothing new starts", async () => {
  const host = new FakeHost();
  const m1 = await bootManager(host);
  const r1 = await reconcile({ client: clientFor(m1.port), deployment, ...fast });
  host.surveyFails = true;
  const m2 = await restartManager(m1, host);
  const h = box(m2.port);
  h.records.set(DEP, { id: DEP, status: "provisioning", isolation: { instance: r1.instance.id } });
  const r = await h.ensureApp(DEP, dep(), { force: true, version: FORCED });
  assert.equal(r.status, "provisioning"); assert.equal(host.running().length, 1);
});

test("forced relaunch on a node that does NOT know the instance (H4): it retires the recovered VM BY NAME first", async () => {
  const { host, m2, vmId } = await recoveredOnManager();
  const h = box(m2.port);
  h.records.set(DEP, { id: DEP, status: "provisioning" });            // a restarted node: no .isolation, no held id
  noSecrets(h);
  // a version the plan ACCEPTS, so nothing but the forced relaunch itself can remove the recovered VM
  const r = await h.ensureApp(DEP, dep(), { force: true, version: PLANNED });
  assert.ok(!host.running().some((x) => x.vmId === vmId), `the recovered VM was never retired (${r.status}: ${r.reason})`);
  assert.equal(host.running().length, 1, "exactly one VM: the fresh one");
  assert.equal(r.status, "running", r.reason);
});

test("giving up while the node does not know the instance (H5): the VM is retired by name BEFORE the lease goes back", async () => {
  const { host, m2 } = await recoveredOnManager();
  const h = box(m2.port);
  h.records.set(DEP, { id: DEP, status: "provisioning" });
  await h.ensureApp(DEP, dep(), { version: YANKED });
  assert.equal(host.running().length, 0, "the lease was given up while the VM runs");
  assert.equal(h.blocked.has(DEP), true, "a confirmed retire lets the give-up proceed");
});

test("giving up when the DELETE fails (H6): no block, no release, still tracked, and the VM keeps its lease", async () => {
  const { host, m2, instanceId } = await recoveredOnManager();
  host.stopFails = true;
  const h = box(m2.port);
  h.tracked.add(DEP);
  h.records.set(DEP, { id: DEP, status: "provisioning", isolation: { instance: instanceId } });
  const r = await h.ensureApp(DEP, dep(), { version: YANKED });
  assert.equal(r.status, "held", r.reason); assert.match(r.reason, /could not be confirmed gone/);
  assert.equal(h.blocked.has(DEP), false); assert.equal(h.tracked.has(DEP), true);
  assert.equal(host.running().length, 1);
});

test("a deployment KNOWN not to be isolated gives up without asking the manager", async () => {
  const h = box(1);                                                    // port 1: nothing answers there
  const d = { ...dep(), configCid: "" };
  const r = await h.ensureApp("0x" + "5f".repeat(32), d, { version: YANKED });
  assert.equal(h.blocked.has("0x" + "5f".repeat(32)), true, JSON.stringify(r));
});

// ---- enclave-d1's re-review of d626da4e ----

test("an UNREAD envelope is unknown, not 'not isolated' (H8): giving up asks the manager first, and holds when it cannot", async () => {
  const h = box(1);                                                    // port 1: nothing answers there
  const id = "0x" + "6a".repeat(32);
  const r = await h.ensureApp(id, { ...dep(), configCid: "{not json" }, { version: YANKED });
  assert.equal(h.records.get(id).isolationRequired, null);
  assert.equal(r.status, "held", r.reason); assert.equal(h.blocked.has(id), false);
});

// A proxy in front of the real manager whose LIST fails (503) while every per-id request passes through: the one state
// in which retiring by the held id and retiring by name differ.
async function listFailsProxy(port) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/vms") { res.writeHead(503, { "content-type": "application/json" }); return res.end('{"error":"list unavailable (proxy)"}'); }
    const up = http.request({ host: "127.0.0.1", port, path: req.url, method: req.method, headers: req.headers, agent: false }, (r) => {
      res.writeHead(r.statusCode, r.headers); r.pipe(res);
    });
    up.on("error", () => { res.writeHead(502); res.end(); }); req.pipe(up);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  return server.address().port;
}

test("the HELD id is retired by that id, even when the manager's list cannot be read (H3)", async () => {
  const { host, m2, instanceId, vmId } = await recoveredOnManager();
  const h = box(await listFailsProxy(m2.port));
  h.records.set(DEP, { id: DEP, status: "provisioning", isolationHeld: instanceId });
  await h.ensureApp(DEP, dep(), { version: YANKED });
  assert.ok(!host.running().some((x) => x.vmId === vmId), "the held VM still runs");
  assert.equal(h.blocked.has(DEP), true, "the retire of the known id was confirmed, so the give-up proceeds");
});

test("a hold caused by VMs that name no deployment NAMES them, so an operator knows which to remove", async () => {
  const host = new FakeHost();
  const m1 = await bootManager(host, 0, { legacyNotes: true });
  const c = clientFor(m1.port);
  const r1 = await reconcile({ client: c, deployment, ...fast });
  await restartManager(m1, host);
  const rr = await retire({ client: c, deployment, ledger: ledger(), instanceId: r1.instance.id });
  assert.equal(rr.removed, false); assert.match(rr.reason, /VMs naming no deployment: orphan-/);
});

test("a domain the node holds or could not confirm gone still occupies the box: its share and slot are not sold again", () => {
  const h = box(1);
  const before = h.capacity();
  h.records.set("0x" + "a1".repeat(32), { id: "0x" + "a1".repeat(32), status: "held", cpuShare: 0.25, memMb: 256, isolation: { instance: "hvA" } });
  h.records.set("0x" + "a2".repeat(32), { id: "0x" + "a2".repeat(32), status: "provisioning", cpuShare: 0.25, memMb: 256, isolationHeld: "hvB" });
  h.records.set("0x" + "a3".repeat(32), { id: "0x" + "a3".repeat(32), status: "failed", cpuShare: 0.25, memMb: 256, isolationRetireFailed: "500" });
  h.records.set("0x" + "a4".repeat(32), { id: "0x" + "a4".repeat(32), status: "held", cpuShare: 0.25, memMb: 256 });   // no VM: a legacy hold
  const after = h.capacity();
  assert.equal(before.slotsFree - after.slotsFree, 3, "three may still run; the legacy hold has no VM");
  assert.ok(Math.abs(h.cpuShareFree() - Math.max(0, 1 - 0.75 - 0.25)) < 1e-9, `cpuShareFree ${h.cpuShareFree()}`);
});

test("an ISOLATED deployment provisioning with no instance id yet (held on a manager 503) holds its share too", () => {
  const h = box(1);
  h.cfg.reservedShare = 0;
  h.records.set("0x" + "b1".repeat(32), { id: "0x" + "b1".repeat(32), status: "provisioning", cpuShare: 0.3, isolationRequired: true });
  h.records.set("0x" + "b2".repeat(32), { id: "0x" + "b2".repeat(32), status: "provisioning", cpuShare: 0.3, isolationRequired: false });
  assert.ok(Math.abs(h.cpuShareFree() - 0.7) < 1e-9, `only the isolated one is counted: cpuShareFree ${h.cpuShareFree()}`);
});

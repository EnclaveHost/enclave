// The node's isolated-domain paths through host.mjs itself (#isolationReconcile, #retireIsolated, #giveUp and the
// forced relaunch), against the REAL manager, the real node client and the real lifecycle. Only Hyper-V is faked:
// a FakeHost whose VMs outlive any manager process, behind a FakeLauncher with the WmiHyperVLauncher surface.
// From enclave-d1's independent review of dad939e9 (its reviewer's probes E1/E2 and H1-H6); the harness follows
// enclave-63's test/windows-isolation-manager-restart.test.mjs, which is left as it is.
//
// THE RULE every test here checks: a lease is given back, and a domain counted gone, only when the domain is KNOWN
// gone. A VM the node cannot name, a manager that cannot answer, and a DELETE that failed all keep the lease.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { Manager, createServer, startManager } from "../windows/vbslike/manager/server.mjs";
import { HyperVPartitionBackend } from "../windows/vbslike/manager/backend.mjs";
import { OWNER_MARKER, MANAGER_NOTES_PREFIX, notesFor } from "../windows/vbslike/manager/wmi-launcher.mjs";
import { IsolationManagerClient } from "../windows/node/isolation-client.mjs";
import { reconcile, retire } from "../windows/node/isolation-lifecycle.mjs";
import { Host } from "../windows/node/host.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const v = JSON.parse(fs.readFileSync(path.join(HERE, "../isolation/contract/catalog/derive_vectors.json"), "utf8"));
const component = Buffer.from(v.component_hex, "hex");
const REC = v.ok[0].mapping.record;
const DEP = "0x" + "e6".repeat(32);
const deployment = { id: DEP, body: { derive: REC, name: DEP, isPublic: true, hasSecrets: false } };
const BOUNDARY = { tier: "t0-hv", partition: "hyperv-vm", hostExcluded: false, attested: false };

class FakeHost {
  constructor() { this.vms = new Map(); this.surveyFails = false; this.stopFails = false; }
  running() { return [...this.vms.values()].filter((x) => x.state === "Running"); }
}
// legacyNotes: the VM carries only the bare owner marker, as a manager before 53672cbe wrote it (an upgrade)
class FakeLauncher {
  constructor(host, { legacyNotes = false } = {}) { this.host = host; this.prefix = "enclave-app-"; this.legacyNotes = legacyNotes; }
  async preflight() { return { ok: true, checks: [{ name: "fake", ok: true }] }; }
  async start(mapping, { instanceId, identity } = {}) {
    const notes = identity && !this.legacyNotes ? notesFor({ ...identity, instanceId }) : OWNER_MARKER;
    const name = this.prefix + instanceId, vmId = crypto.randomUUID();
    this.host.vms.set(name, { name, vmId, state: "Running", notes, appId: mapping.appId });
    return { instanceId, name, vmId, state: "Running", image: "ab".repeat(32), boundary: BOUNDARY, appId: mapping.appId,
             guest: { booted: true, bytes: 9, head: "" }, appReady: false, tcpPort: 19000 + this.host.vms.size, launcherKey: "LKEY",
             stop: async () => await this.stop({ name, vmId }) };
  }
  async stop(handle) {
    if (this.host.stopFails) throw new Error("Stop-VM failed (fake)");
    if (!handle || !handle.vmId) throw new Error("by id only");
    const vm = [...this.host.vms.values()].find((x) => x.vmId === handle.vmId);
    if (vm) this.host.vms.delete(vm.name);
    return { stopped: true, removed: !!vm, name: handle.name ?? null, vmId: handle.vmId };
  }
  async state(name) { const x = this.host.vms.get(name); return x ? { found: true, state: x.state } : { found: false }; }
  async survey() {
    if (this.host.surveyFails) throw new Error("Get-VM failed (fake)");
    return { vms: [...this.host.vms.values()].filter((x) => x.name.startsWith(this.prefix) || String(x.notes).startsWith(MANAGER_NOTES_PREFIX))
                   .map((x) => ({ vmId: x.vmId, name: x.name, state: x.state, notes: x.notes })) };
  }
  async teardown() { return { removed: 0 }; }
}
const judgeRunning = async () => ({ status: "running", transportKeySha256: "cd".repeat(32),
                                    checks: { document: { ok: true, verdict: "monitor-signed" }, ready: { ok: true } } });
const live = new Set();
after(() => { for (const s of live) { s.closeAllConnections?.(); s.close(); } });
// booted exactly as main.mjs boots it: construct, startManager (probe + recover), listen
async function bootManager(host, port = 0, { legacyNotes = false } = {}) {
  const manager = new Manager({ judgeReady: judgeRunning, runtimeId: REC.runtimeId, fetchComponent: async () => component,
                                backend: new HyperVPartitionBackend({ launcher: new FakeLauncher(host, { legacyNotes }) }) });
  await startManager(manager);
  const server = createServer(manager);
  await new Promise((res) => server.listen(port, "127.0.0.1", res));
  live.add(server);
  return { manager, server, port: server.address().port };
}
async function restartManager(m, host) {
  m.server.closeAllConnections?.();
  await new Promise((r) => m.server.close(r)); live.delete(m.server);
  return await bootManager(host, m.port);
}
// no keep-alive: a restart on the same port must not be answered by a pooled socket to the old process
function freshFetch(url, { method = "GET", headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, agent: false, signal }, (res) => {
      const c = []; res.on("data", (x) => c.push(x));
      res.on("end", () => { const t = Buffer.concat(c).toString("utf8"); resolve({ status: res.statusCode, text: async () => t }); });
    });
    req.on("error", reject); if (body !== undefined) req.write(body); req.end();
  });
}
const clientFor = (port) => new IsolationManagerClient({ base: `http://127.0.0.1:${port}`, timeoutMs: 5_000, fetchImpl: freshFetch });
const ledger = () => { const released = []; return { released, release: async (n, why) => { released.push(why); } }; };
const fast = { pollMs: 5, deadlineMs: 2_000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

const ISOLATED = JSON.stringify({ isolation: { require: "hyperv-partition-per-app" } });
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
// a version the plan accepts (the derive vector's own app, index, CID and policy), so ensureApp reaches reconcile
const PLANNED = { appId: REC.catalog.app, index: REC.catalog.version, cid: REC.cid, version: REC.catalog.version,
                  memMb: REC.policy.memMiB, config: "{}" };

// a domain started by one manager, which then restarted: the new manager lists it recovered:true
async function recoveredOnManager() {
  const host = new FakeHost();
  const m1 = await bootManager(host);
  const r1 = await reconcile({ client: clientFor(m1.port), deployment, ...fast });
  const m2 = await restartManager(m1, host);
  assert.equal(m2.manager.get(r1.instance.id).recovered, true);
  return { host, m2, instanceId: r1.instance.id, vmId: host.running()[0].vmId };
}

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
  h.cfg.secretsSign = async () => "0x" + "11".repeat(65); h.secrets.set(DEP, {});   // known: no staged secrets
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
  h.cfg.secretsSign = async () => "0x" + "11".repeat(65); h.secrets.set(DEP, {});
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
  h.cfg.secretsSign = async () => "0x" + "11".repeat(65); h.secrets.set(DEP, {});
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

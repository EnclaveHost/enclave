// The Windows isolation manager, REAL, over a faked Hyper-V: shared by the node's isolated-domain tests
// (test/windows-node-isolation-host.test.mjs, test/windows-node-stopapp-tick.test.mjs). A FakeHost's VMs outlive any
// manager process, behind a FakeLauncher with the WmiHyperVLauncher surface; the manager is booted exactly as main.mjs
// boots it (construct, startManager, listen). It follows enclave-63's test/windows-isolation-manager-restart.test.mjs,
// which keeps its own copy.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { Manager, createServer, startManager } from "../../windows/vbslike/manager/server.mjs";
import { HyperVPartitionBackend } from "../../windows/vbslike/manager/backend.mjs";
import { OWNER_MARKER, MANAGER_NOTES_PREFIX, notesFor } from "../../windows/vbslike/manager/wmi-launcher.mjs";
import { IsolationManagerClient } from "../../windows/node/isolation-client.mjs";
import { reconcile } from "../../windows/node/isolation-lifecycle.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const v = JSON.parse(fs.readFileSync(path.join(HERE, "../../isolation/contract/catalog/derive_vectors.json"), "utf8"));
const component = Buffer.from(v.component_hex, "hex");
export const REC = v.ok[0].mapping.record;
export const DEP = "0x" + "e6".repeat(32);
export const deployment = { id: DEP, body: { derive: REC, name: DEP, isPublic: true, hasSecrets: false } };
export const ISOLATED = JSON.stringify({ isolation: { require: "hyperv-partition-per-app" } });
// a catalog version the node's plan accepts (the derive vector's own app, index, CID and policy)
export const PLANNED = { appId: REC.catalog.app, index: REC.catalog.version, cid: REC.cid, version: REC.catalog.version,
                         memMb: REC.policy.memMiB, config: "{}" };
const BOUNDARY = { tier: "t0-hv", partition: "hyperv-vm", hostExcluded: false, attested: false };

export class FakeHost {
  constructor() { this.vms = new Map(); this.surveyFails = false; this.stopFails = false; this.stops = 0; }
  running() { return [...this.vms.values()].filter((x) => x.state === "Running"); }
  // a VM under this manager's prefix that carries only the bare owner marker: what an upgrade leaves behind
  addOrphan(name = "enclave-app-orphan") { this.vms.set(name, { name, vmId: crypto.randomUUID(), state: "Running", notes: OWNER_MARKER }); }
}
// legacyNotes: the VM carries only the bare owner marker, as a manager before 53672cbe wrote it
export class FakeLauncher {
  constructor(host, { legacyNotes = false } = {}) { this.host = host; this.prefix = "enclave-app-"; this.legacyNotes = legacyNotes; }
  async preflight() { return { ok: true, checks: [{ name: "fake", ok: true }] }; }
  async start(mapping, { instanceId, identity } = {}) {
    const notes = identity && !this.legacyNotes ? notesFor({ ...identity, instanceId }) : OWNER_MARKER;
    const name = this.prefix + instanceId, vmId = crypto.randomUUID();
    this.host.vms.set(name, { name, vmId, state: "Running", notes, appId: mapping.appId });
    return { instanceId, name, vmId, state: "Running", image: "ab".repeat(32), boundary: BOUNDARY, appId: mapping.appId,
             guest: { booted: true, bytes: 9, head: "" }, appReady: false, tcpPort: 19000 + this.host.vms.size, launcherKey: "LKEY", launcherVmId: vmId,
             stop: async () => await this.stop({ name, vmId }) };
  }
  async stop(handle) {
    this.host.stops++;
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
/** Close every manager this module started (call from the test file's `after`). */
export function closeManagers() { for (const s of live) { s.closeAllConnections?.(); s.close(); } live.clear(); }

export async function bootManager(host, port = 0, { legacyNotes = false } = {}) {
  const manager = new Manager({ judgeReady: judgeRunning, runtimeId: REC.runtimeId, fetchComponent: async () => component,
                                backend: new HyperVPartitionBackend({ launcher: new FakeLauncher(host, { legacyNotes }) }) });
  await startManager(manager);
  const server = createServer(manager);
  await new Promise((res) => server.listen(port, "127.0.0.1", res));
  live.add(server);
  return { manager, server, port: server.address().port };
}
export async function restartManager(m, host) {
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
export const clientFor = (port) => new IsolationManagerClient({ base: `http://127.0.0.1:${port}`, timeoutMs: 5_000, fetchImpl: freshFetch });
export const ledger = () => { const released = []; return { released, release: async (n, why) => { released.push(why); } }; };
export const fast = { pollMs: 5, deadlineMs: 2_000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** A domain started by one manager, which then restarted: the new manager lists it recovered:true. */
export async function recoveredOnManager({ withOrphan = false } = {}) {
  const host = new FakeHost();
  const m1 = await bootManager(host);
  const r1 = await reconcile({ client: clientFor(m1.port), deployment, ...fast });
  if (withOrphan) host.addOrphan();
  const m2 = await restartManager(m1, host);
  if (m2.manager.get(r1.instance.id)?.recovered !== true) throw new Error("the harness did not recover the domain");
  return { host, m2, instanceId: r1.instance.id, vmId: host.vms.get("enclave-app-" + r1.instance.id)?.vmId };
}

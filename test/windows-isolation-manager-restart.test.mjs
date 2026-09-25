// A manager restart must not free a lease while its VM still runs, and must not start a second VM
// for the same deployment (enclave-63's carry-over review, P1/P1b/P1c; d1 owns the manager fix,
// 5d the node lifecycle side).
//
// Hyper-V VMs outlive the manager process. The manager's records live in an in-memory Map, so a
// restarted manager knows nothing about the VMs its predecessor started, and the node reads its
// answers as knowledge:
//   P1   retire(instanceId): DELETE 404 -> {absent} -> re-read null -> "removed and confirmed gone"
//   P1b  retire(no id):      findByName null -> "no domain for this deployment" -> lease released
//   P1c  reconcile waiting:  get() null -> "disappeared from the manager" -> lease released
//   and  reconcile again:    findByName null -> spawn -> a SECOND VM for the same deployment
// "Unknown to a younger manager" is not "gone".
//
// HARNESS. Everything real except Hyper-V: the manager (server.mjs Manager + createServer, booted
// exactly as main.mjs boots it: construct, probe(), listen) on loopback, the node's real
// IsolationManagerClient over HTTP, and the real isolation-lifecycle reconcile/retire. Hyper-V is a
// FakeHost whose VMs live outside any manager process, behind a FakeLauncher with the
// WmiHyperVLauncher surface the backend uses (preflight/start/stop/state/survey/teardown, same
// return shapes as wmi-launcher.mjs at c067b446). A restart closes the HTTP server, drops the
// Manager, and boots a fresh one on the SAME port over the SAME host.
//
// TWO KINDS OF TEST.
//   "BUG REPRODUCTION"  assert today's behaviour. They pass now and prove the harness really loses
//                        the manager's state while the VM really survives, so the invariant tests
//                        below cannot pass vacuously. They are EXPECTED TO FAIL once the fix lands:
//                        that failure is the signal; delete them then.
//   "INVARIANT"         the rule, stated independently of how the fix is built: after any sequence
//                        of restarts, (a) a lease is never released while a VM for that deployment
//                        still runs on the host, and (b) at most one VM runs per deployment. Marked
//                        `todo` until the fix lands (a todo test runs and reports, but does not fail
//                        the suite); remove `todo` then. A manager epoch answered 409/410 already
//                        maps to HELD in the node today (client.remove/get throw on non-404), and a
//                        truthful rebuilt inventory makes 404/null mean gone again - so either side
//                        can satisfy them; the "cannot read Hyper-V at restart" case is the one that
//                        needs the node (or the manager) to refuse to treat unknown as gone.
//
// WHEN THE FIX CHANGES THE LAUNCHER SURFACE (e.g. VM Notes carrying deploymentId/id/epoch, or a
// startup inventory step in main.mjs), change FakeLauncher / bootManager to match and nothing else.
// bootManager must keep doing exactly what main.mjs does at start.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { Manager, createServer, startManager } from "../windows/vbslike/manager/server.mjs";
import { HyperVPartitionBackend } from "../windows/vbslike/manager/backend.mjs";
import { OWNER_MARKER, MANAGER_NOTES_PREFIX, notesFor } from "../windows/vbslike/manager/wmi-launcher.mjs";
import { IsolationManagerClient } from "../windows/node/isolation-client.mjs";
import { reconcile, retire } from "../windows/node/isolation-lifecycle.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const v = JSON.parse(fs.readFileSync(path.join(HERE, "../isolation/contract/catalog/derive_vectors.json"), "utf8"));
const component = Buffer.from(v.component_hex, "hex");
const REC = v.ok[0].mapping.record;
const DEP = "0x" + "e6".repeat(32);
// the body the node client actually sends (guestd's contract, name included), as in server.test.mjs
const deployment = { id: DEP, body: { derive: REC, name: DEP, isPublic: true, hasSecrets: false } };
const BOUNDARY = { tier: "t0-hv", partition: "hyperv-vm", hostExcluded: false, attested: false };

/** Hyper-V: VMs live here, outside any manager process, exactly as real VMs outlive it. */
class FakeHost {
  constructor() { this.vms = new Map(); this.surveyFails = false; }   // name -> { name, vmId, state, notes, appId }
  running() { return [...this.vms.values()].filter((x) => x.state === "Running"); }
}

/** The WmiHyperVLauncher surface HyperVPartitionBackend uses, over a FakeHost. */
class FakeLauncher {
  constructor(host, { prefix = "enclave-app-" } = {}) { this.host = host; this.prefix = prefix; this.created = new Set(); }
  async preflight() { return { ok: true, checks: [{ name: "fake Hyper-V host", ok: true }] }; }
  // Mirrors wmi-launcher.mjs (d1's fix): the identity goes into the VM's Notes, stop acts by VM Id.
  async start(mapping, { instanceId, identity } = {}) {
    const notes = identity ? notesFor({ ...identity, instanceId }) : OWNER_MARKER;
    const name = this.prefix + instanceId;
    if (this.host.vms.has(name)) throw new Error(`a VM named ${name} already exists`);
    const vmId = crypto.randomUUID();
    this.host.vms.set(name, { name, vmId, state: "Running", notes: notes ?? OWNER_MARKER, appId: mapping.appId });
    this.created.add(name);
    // wmi-launcher.mjs's handle shape, plus a relay port so readiness can be judged: the real WMI
    // handle carries none today, which leaves a WMI domain `starting` ("no relay port") - a separate
    // observation, not what this file tests.
    return { instanceId, name, vmId, state: "Running", image: "ab".repeat(32), boundary: BOUNDARY,
             appId: mapping.appId, guest: { booted: true, bytes: 9, head: "" }, appReady: false,
             tcpPort: 19000 + this.host.vms.size, launcherKey: "LKEY",
             stop: async () => await this.stop({ name, vmId }) };
  }
  async stop(handle) {
    // BY ID, as the real launcher now does (P2); stop-and-remove, so nothing is left Off with its identity.
    if (!handle || !handle.vmId) throw new Error("the launcher acts by VM Id; a name is not an identity");
    const vm = [...this.host.vms.values()].find((x) => x.vmId === handle.vmId);
    if (vm) this.host.vms.delete(vm.name);
    return { stopped: true, removed: !!vm, name: handle.name ?? null, vmId: handle.vmId };
  }
  async state(name) { const x = this.host.vms.get(name); return x ? { found: true, state: x.state } : { found: false }; }
  async survey() {
    if (this.host.surveyFails) throw new Error("Get-VM failed: the virtualization namespace did not answer");
    return { vms: [...this.host.vms.values()].filter((x) => x.name.startsWith(this.prefix) || String(x.notes).startsWith(MANAGER_NOTES_PREFIX))
                   .map((x) => ({ vmId: x.vmId, name: x.name, state: x.state, notes: x.notes })) };
  }
  async teardown() { let removed = 0; for (const n of [...this.created]) { if (this.host.vms.delete(n)) removed++; this.created.delete(n); } return { removed }; }
}

const judgeRunning = async () => ({ status: "running", transportKeySha256: "cd".repeat(32),
                                    checks: { document: { ok: true, verdict: "monitor-signed" }, ready: { ok: true } } });

const live = new Set();
after(() => { for (const s of live) { s.closeAllConnections?.(); s.close(); } });

/** Boot a manager the way main.mjs does: construct, startManager() (probe + inventory), listen on loopback. */
async function bootManager(host, port = 0, { judgeReady = judgeRunning } = {}) {
  const manager = new Manager({ judgeReady, runtimeId: REC.runtimeId, fetchComponent: async () => component,
                                backend: new HyperVPartitionBackend({ launcher: new FakeLauncher(host) }) });
  await startManager(manager);
  const server = createServer(manager);
  await new Promise((res, rej) => { server.once("error", rej); server.listen(port, "127.0.0.1", () => { server.off("error", rej); res(); }); });
  live.add(server);
  return { manager, server, port: server.address().port };
}

/** The process dies (its Map with it); a new one boots on the same port over the same host. */
async function restartManager(m, host, opts) {
  m.server.closeAllConnections?.();
  await new Promise((r) => m.server.close(r));
  live.delete(m.server);
  return await bootManager(host, m.port, opts);
}

// The node's client, with one change: a FRESH connection per request (agent:false). With the
// default pooled fetch, the first request after a restart may reuse a keep-alive socket to the dead
// process and fail as "transport" - which retire/reconcile correctly treat as HELD - so whether a
// test saw the bug depended on a socket race rather than on what the manager ANSWERED. That race is
// real but transient (the next attempt reaches the new manager); this file tests the answers.
function freshFetch(url, { method = "GET", headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, agent: false, signal }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); resolve({ status: res.statusCode, text: async () => text }); });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const clientFor = (port) => new IsolationManagerClient({ base: `http://127.0.0.1:${port}`, timeoutMs: 5_000, fetchImpl: freshFetch });

function ledger() { const released = []; return { released, release: async (name, why) => { released.push({ name, why }); } }; }
const fast = { pollMs: 5, deadlineMs: 5_000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** One deployment reconciled to a running domain on a first manager. */
async function running(host) {
  const m1 = await bootManager(host);
  const client = clientFor(m1.port);
  const r = await reconcile({ client, deployment, ...fast });
  assert.equal(r.action, "spawned", `precondition: the first manager starts it (${r.reason})`);
  assert.equal(r.instance.status, "running", "precondition: and it is serving");
  assert.equal(host.running().length, 1, "precondition: one VM on the host");
  return { m1, client, instanceId: r.instance.id };
}

// The invariant, as one check: never a released lease while a VM for the deployment runs, and never
// two VMs for one deployment.
function assertInvariant(host, led, what) {
  const vms = host.running();                    // this file runs exactly one deployment per host
  assert.ok(vms.length <= 1, `${what}: ${vms.length} VMs run for one deployment`);
  assert.ok(!(led.released.length > 0 && vms.length > 0),
    `${what}: the lease was released (${led.released.map((x) => x.why).join("; ")}) while a VM still runs`);
}

// ---- BUG REPRODUCTIONS: DELETED when the fix landed, as their author (enclave-63) specified. They
// reproduced P1, P1b, the second VM on reconcile, and P1c at c99a9848 and fail against the fix, which is
// the signal they were written to give. The invariants below are the lasting tests.

// ---- INVARIANT (todo until the manager fix, d1, and/or the node lifecycle fix, 5d, land) ----------

// The manager fix landed (d1: inventory rebuilt from the VMs' Notes, 503 until surveyed, act by VM Id), so these are LIVE.
const TODO = false;

test("INVARIANT P1: retire(instanceId) after a restart never frees a lease while the VM runs", { todo: TODO }, async () => {
  const host = new FakeHost();
  const { m1, client, instanceId } = await running(host);
  await restartManager(m1, host);
  const led = ledger();
  await retire({ client, deployment, ledger: led, instanceId });
  assertInvariant(host, led, "retire(instanceId) after a restart");
});

test("INVARIANT P1b: retire(no id) after a restart never frees a lease while the VM runs", { todo: TODO }, async () => {
  const host = new FakeHost();
  const { m1, client } = await running(host);
  await restartManager(m1, host);
  const led = ledger();
  await retire({ client, deployment, ledger: led });
  assertInvariant(host, led, "retire(no id) after a restart");
});

// THE NODE SIDE LANDED (enclave-5d, windows/node/isolation-lifecycle.mjs RECOVERED): a restarted manager lists the
// surviving VM as `starting` + `recovered: true` (alive, not serving, never to become running under the new
// process), and reconcile now HOLDS it at once: the lease is kept, no second VM, nothing removed.
test("INVARIANT: reconcile after a restart adopts or holds, and never starts a second VM", { todo: false }, async () => {
  const host = new FakeHost();
  const { m1, client } = await running(host);
  const before = host.running()[0].vmId;
  await restartManager(m1, host);
  const led = ledger();
  const r = await reconcile({ client, deployment, ledger: led, ...fast });
  assert.ok(["adopted", "held"].includes(r.action), `reconcile ${r.action}: ${r.reason}`);
  assertInvariant(host, led, "reconcile after a restart");
  assert.equal(host.running()[0]?.vmId, before, "the VM that survived the restart is the one still running");
});

test("INVARIANT P1c: a restart while reconcile waits never frees a lease while the VM runs", { todo: TODO }, async () => {
  const host = new FakeHost();
  let m = await bootManager(host, 0, { judgeReady: () => new Promise(() => {}) });
  const client = clientFor(m.port);
  const led = ledger();
  let restarted = false;
  const r = await reconcile({ client, deployment, ledger: led, pollMs: 5, deadlineMs: 2_000,
    sleep: async () => { if (!restarted) { restarted = true; m = await restartManager(m, host, { judgeReady: () => new Promise(() => {}) }); } } });
  assert.ok(!(r.leaseFree && host.running().length > 0), `reconcile freed the lease (${r.reason}) while the VM runs`);
  assertInvariant(host, led, "restart during reconcile's wait");
});

test("INVARIANT: a manager that cannot read Hyper-V at restart still never frees the lease or doubles the VM", { todo: TODO }, async () => {
  // The case a rebuilt inventory alone cannot cover: the rebuild itself fails. Unknown must stay
  // unknown - on the manager side (refuse to answer as if its inventory were complete) or the node
  // side (a younger manager's "not found" is HELD).
  const host = new FakeHost();
  const { m1, client, instanceId } = await running(host);
  host.surveyFails = true;
  await restartManager(m1, host);
  const led = ledger();
  await retire({ client, deployment, ledger: led, instanceId });
  await retire({ client, deployment, ledger: led });
  await reconcile({ client, deployment, ledger: led, ...fast });
  assertInvariant(host, led, "restart with Hyper-V unreadable");
});

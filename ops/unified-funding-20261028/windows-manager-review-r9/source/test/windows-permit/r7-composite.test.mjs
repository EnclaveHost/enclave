// permit r7 POSITIVE COMPOSITE, r8 carry of the ROOT-CORRECTED version (evidence/root-r7/root-composite.test.mjs, PASS at root) with
// portable relative imports. Root corrections carried exactly: (1) the TEST lifecycle journal's read(id).sequence is the ACTUAL gate
// permit journal's sequence (the author r7 fixture kept a separate counter, which is why the author version failed renewal); (2) TCP goes
// through the ACTUAL router dataServer (the author r7 version spliced the legacy data plane directly). The positive increasing-sequence
// and new-digest renewal assertions are unchanged. The author r7 failure evidence stays in evidence/root-r7 (focused-result.tap).
// PROVENANCE CORRECTION (r8): the r7 header and REPORT section 2 said this composite was "written first". The root mutation audit shows
// the r7 runtime/supervisor/client edits came first, then the withdrawal and owner tests, then this composite. That claim was inaccurate.
// Chain: isolation-lifecycle.reconcile (what host.mjs #isolationReconcile calls) -> protectedSupervisorFor (pinned enrollment; the policy's
//   manager origin is the ROUTER) -> ProtectedSupervisor -> r18 createIsolationLifecycleRuntime (candidate copy) -> DeploymentPermitGate ->
//   ProtectedIsolationClient -> GuestdControl (real handshake/MAC over TCP) -> router controlServer/CompositeManager (REAL snapshot,
//   precheck, admission, router/attest.mjs verify-before-latch, LaunchJournal pending cost, observePending same-epoch accounting) ->
//   router io makeRequest -> BOTH real manager servers: the legacy ProtectedManager (composeProtected: PermitEnforcement, ControlServer,
//   createProtectedServer with the TEST owner-selected router key) and a second real Manager (createServer) in the native role
//   (applyNativeRole: scope marker + pinned spawn wrapper) -> real guard process -> router dataServer -> real data-plane splice to a TEST
//   echo relay.
// Shared RAM/physical/CPU pools are configured identically on both managers; the router's availableMemoryMiB is a TEST host-headroom
// reading so the 17 GiB floor participates (positive and negative). An ordinary (unenrolled) neighbour is spawned through the same router.
// NOTHING in the router is overridden: snapshot/precheck/admission/attest/observePending are the shipped code.
// TEST and labelled: JSON "Hyper-V" inventories, launcher/readiness doubles (the launcher confirms the exact type-1 physical allocation
// the manager reserved), TEST authority snapshot + owner-selected TEST witnesses, TEST in-memory r18 lifecycle journal, in-process log
// exclusion, and a TEST native DESKTOP DESCRIPTOR on the native manager's /health (desktop.ready:false). Consequence stated plainly: a
// RUNNING native neighbour and a native PROTECTED stage are NOT exercised here (see REPORT-WINDOWS-PERMIT-R8 native section).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { createHash } from "node:crypto";
import { HyperVPartitionBackend } from "../../control/windows/vbslike/manager/backend.mjs";
import { Manager, startManager, createServer } from "../../control/windows/vbslike/manager/server.mjs";
import { ProtectedManager } from "../../control/windows/vbslike/manager/protected-manager.mjs";
import { composeProtected, dataLookup, applyNativeRole } from "../../control/windows/vbslike/manager/compose.mjs";
import { type1VmMemMiB } from "../../control/windows/vbslike/manager/wmi-launcher.mjs";
import { CONFIG_SCHEMA, TEST_QUALIFICATION } from "../../control/windows/vbslike/manager/permit-enforcement.mjs";
import { openOwnedLog, initializeOwnedLog, TEST_inProcessExclusion } from "../../control/windows/vbslike/manager/win-durable.mjs";
import { openPermitJournal } from "../../control/windows/vbslike/manager/permit-journal.mjs";
import { GuardClient } from "../../control/windows/vbslike/guard/guard-client.mjs";
import { dataPlaneFor } from "../../control/windows/vbslike/datapath/node-bridge.mjs";
import { CompositeManager, LaunchJournal } from "../../control/windows/vbslike/router/control.mjs";
import { makeRequest, controlServer, dataServer } from "../../control/windows/vbslike/router/io.mjs";
import { DeploymentPermitGate } from "../../control/network/deployment-permit-gate.mjs";
import { createIsolationLifecycleRuntime } from "../../control/network/deployment-isolation-runtime.mjs";
import { IsolationManagerClient } from "../../control/windows/node/isolation-client.mjs";
import { reconcile } from "../../control/windows/node/isolation-lifecycle.mjs";
import { ownedObligationStore, OBLIGATION_PURPOSE } from "../../control/windows/node/protected-isolation.mjs";
import { composition, TEST_resetProtectedComposition, ENROLLMENT_SCHEMA } from "../../control/windows/node/protected-supervisor.mjs";
import { PINS, HOST, DEPLOYMENT, KEY, vectors, tmp, writeInv, readInv, testLauncher, echoServer, startGuard, selfIdentity, testAuthority, envelope, waitFor } from "./helpers/world.mjs";

const POOLS = Object.freeze({ ramPoolMiB: 16 * 1024, cpuPoolVcpus: 4, physicalRamPoolMiB: 24 * 1024 });
const NATIVE_PINS = Object.freeze({ deployment: "0x" + "d0".repeat(32), catalogApp: "0x" + "d1".repeat(32), runtimeId: "d2".repeat(32), profileSha256: "d3".repeat(32),
  igvmSha256: "d4".repeat(32), controllerSha256: "d5".repeat(32), catalogVersion: 1, cid: "bafyTESTnative" });
const NEIGHBOUR = "0x" + "77".repeat(32);

/** TEST launcher: the shared JSON inventory double, confirming the exact type-1 physical allocation the manager reserved. */
function confirmingLauncher(opts) {
  const l = testLauncher(opts), start = l.start.bind(l);
  l.start = async (mapping, o) => ({ ...(await start(mapping, o)), memory: { vmMiB: type1VmMemMiB(o.appMemoryMiB ?? mapping.record.policy.memMiB, { name: o.identity.name, appId: o.identity.appId }) } });
  return l;
}
function TEST_lifecycleJournal(permitJournal) {
  const rows = new Map(); const row = (id) => rows.get(id) ?? { sequence: 0, runtime: null, attempts: 0 };
  return { label: "TEST-in-memory-lifecycle-journal", read: (id) => ({ ...row(id), sequence: permitJournal.read(id).sequence }),
    rememberRuntime(id, { instance, generation, now }) { const r = row(id); const prev = r.runtime?.instance === instance ? r.runtime : null;
      r.runtime = { instance, generation, startedAt: prev?.startedAt ?? now }; rows.set(id, r); return r.runtime; },
    retireRuntime(id, instance) { const r = row(id); if (r.runtime?.instance === instance) r.runtime = null; rows.set(id, r); },
    beginAttempt(id) { const r = row(id); r.attempts++; rows.set(id, r); return r.attempts; },
    bumpSequence(id) { const r = row(id); r.sequence++; rows.set(id, r); } };
}
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", r));

async function composite(t) {
  TEST_resetProtectedComposition();
  const dir = tmp(t), { record, component } = vectors();
  const relayPort = await echoServer(t);
  const judgeReady = async () => ({ status: "running", transportKeySha256: KEY, checks: { document: { verdict: "TEST" } } });
  // ---- the legacy (protected-capable) manager ----
  const inventory = path.join(dir, "inventory.json"); writeInv(inventory, { vms: [] });
  const legacy = new ProtectedManager({ backend: new HyperVPartitionBackend({ launcher: confirmingLauncher({ file: inventory, relayPort }) }), runtimeId: record.runtimeId,
    fetchComponent: async () => component, judgeReady, ...POOLS });
  await startManager(legacy);
  const jfile = path.join(dir, "permit.log"); initializeOwnedLog(jfile, { purpose: "enclave-manager-permit/1" });
  const log = openOwnedLog(jfile, { purpose: "enclave-manager-permit/1", exclusion: TEST_inProcessExclusion() }); t.after(() => { try { log.release(); } catch {} });
  const g = await startGuard(t, dir, { inventory });
  const guard = await GuardClient.connect({ path: g.socket, key: g.key, identity: { ...selfIdentity(), epoch: legacy.epoch } }); t.after(() => guard.close());
  let enforcement = null;
  const dp = dataPlaneFor(dataLookup(legacy, () => enforcement)); await listen(dp.server); t.after(() => dp.server.close());
  const authority = testAuthority({ now: Date.now });
  const controlKey = crypto.randomBytes(32), routerKey = crypto.randomBytes(32);
  const computeRemover = { label: "TEST-independent-remover", async survey() { return readInv(inventory); },
    async removeById(vmId) { const j = readInv(inventory), n = j.vms.length; j.vms = j.vms.filter((v) => v.vmId !== vmId); writeInv(inventory, j); return n === j.vms.length ? { found: false, removed: false } : { found: true, removed: true }; } };
  const c = await composeProtected({ manager: legacy, enforcementConfig: { schema: CONFIG_SCHEMA, pins: PINS, host: HOST, maxStagingMs: 60_000, derivations: ["enclave-catalog-bundle/1"], qualification: TEST_QUALIFICATION, retryMs: 200 },
    journal: openPermitJournal(log), guard, authority, dataPlane: dp, computeRemover, controlKey, routerKey });
  enforcement = c.enforcement;
  await listen(c.server); t.after(async () => { c.server.closeAllConnections(); await new Promise((r) => c.server.close(r)); });
  // ---- the second real manager, native role (own inventory, same pools and boundary) ----
  const nativeInventory = path.join(dir, "native-inventory.json"); writeInv(nativeInventory, { vms: [] });
  const native = new Manager({ backend: new HyperVPartitionBackend({ launcher: confirmingLauncher({ file: nativeInventory, relayPort }) }), runtimeId: record.runtimeId,
    fetchComponent: async () => component, judgeReady, ...POOLS });
  await startManager(native);
  applyNativeRole(native, NATIVE_PINS, { port: 8095, dataPort: 8096 });   // the entry's exact wrapper (ports are the role contract; listening is ephemeral here)
  const nativeHealth = native.health;
  // TEST native desktop descriptor (labelled; see header): pins only, desktop NOT ready, so native admission stays off
  native.health = () => ({ ...nativeHealth(), desktop: { ready: false, runtime: null, runtimeId: NATIVE_PINS.runtimeId, igvmSha256: NATIVE_PINS.igvmSha256,
    profileSha256: NATIVE_PINS.profileSha256, controllerSha256: NATIVE_PINS.controllerSha256, allocatedGpuMilli: 0, freeGpuMilli: 0 } });
  const nativeServer = createServer(native); await listen(nativeServer); t.after(async () => { nativeServer.closeAllConnections?.(); await new Promise((r) => nativeServer.close(r)); });
  // ---- the actual router ----
  const rfile = path.join(dir, "router.log"); LaunchJournal.initialize(rfile); const rjournal = new LaunchJournal(rfile);
  const host = { freeMiB: 64 * 1024 };   // TEST host physical headroom reading (the 17 GiB floor is the router's)
  const router = new CompositeManager({ journal: rjournal, nativePins: NATIVE_PINS, availableMemoryMiB: async () => host.freeMiB, attestKey: routerKey,
    request: makeRequest({ legacyPort: c.server.address().port, nativePort: nativeServer.address().port }) });
  const rsrv = controlServer(router); await listen(rsrv); t.after(async () => { rsrv.closeAllConnections(); await new Promise((r) => rsrv.close(r)); });
  // ROOT correction: exercise the actual router data plane, not a direct legacy-manager shortcut.
  const nativeDp = dataPlaneFor(native); await listen(nativeDp.server); t.after(() => nativeDp.server.close());
  const compositeDp = dataServer({ legacyPort: dp.server.address().port, nativePort: nativeDp.server.address().port });
  await listen(compositeDp.server); t.after(() => compositeDp.close());
  const routerBase = `http://127.0.0.1:${rsrv.address().port}`;
  const plain = async (method, p) => { const r = await fetch(routerBase + p, { method, signal: AbortSignal.timeout(5000) }); return { status: r.status, body: await r.json() }; };
  // ---- the node: pinned enrollment whose manager origin is the ROUTER ----
  const keyFile = path.join(dir, "control.key"); fs.writeFileSync(keyFile, controlKey.toString("hex"), { mode: 0o600 });
  const pol = Buffer.from(JSON.stringify({ schema: ENROLLMENT_SCHEMA, host: HOST, manager: routerBase, controlKeyFile: keyFile, deployments: [DEPLOYMENT], stagingMs: 30_000 }));
  const polFile = path.join(dir, "enrollment.json"); fs.writeFileSync(polFile, pol);
  const sfile = path.join(dir, "supervisor-permit.log"); initializeOwnedLog(sfile, { purpose: "enclave-manager-permit/1" });
  const slog = openOwnedLog(sfile, { purpose: "enclave-manager-permit/1", exclusion: TEST_inProcessExclusion() }); t.after(() => { try { slog.release(); } catch {} });
  const sj = openPermitJournal(slog);
  const gate = new DeploymentPermitGate({ pins: PINS, journal: sj, hostAuthority: sj.hostAuthority });
  const ofile = path.join(dir, "protected-obligations.log"); initializeOwnedLog(ofile, { purpose: OBLIGATION_PURPOSE });
  const olog = openOwnedLog(ofile, { purpose: OBLIGATION_PURPOSE, exclusion: TEST_inProcessExclusion() }); t.after(() => { try { olog.release(); } catch {} });
  const collected = [];
  composition.hostId = HOST;
  composition.store = ownedObligationStore(olog);
  composition.collect = async (rec) => { const e = await envelope(rec); collected.push(e); return e; };
  composition.openRuntime = async ({ host: h, bind }) => {
    const a = bind({ gate, pins: PINS });
    const runtime = createIsolationLifecycleRuntime({ client: a.client, gate, journal: TEST_lifecycleJournal(sj), plans: a.plans, readiness: a.readiness, collectPermit: a.collectPermit, boundaries: a.boundaries, host: h });
    return { runtime, gate, pins: PINS, handoff: { owns: () => true, activated: () => true, why: () => null, activate: async () => [], newWorkRefusal: () => null, label: "TEST fixture (r9): route handoff pre-activated; the real dispatch handoff is r9-real-owned-factory" }, snapshot: async (id) => { const ctx = await authority.read(id);
      return { ...ctx, id, blockAt: ctx.assignment.observedAt * 1000, blockHash: ctx.assignment.blockHash, authorityTier: ctx.assignment.authorityTier, admitted: ctx.hostAdmitted, funded: ctx.assignment.funded, verified: ctx.assignment.proofVerified, assignment: { ...ctx.assignment, revision: 1 }, hostAuthorityEvidence: ctx.hostAuthority, profile: PINS.profile }; } };
  };
  process.env.ENCLAVE_PROTECTED_ENROLLMENT = polFile;
  process.env.ENCLAVE_PROTECTED_ENROLLMENT_SHA256 = createHash("sha256").update(pol).digest("hex");
  t.after(() => { delete process.env.ENCLAVE_PROTECTED_ENROLLMENT; delete process.env.ENCLAVE_PROTECTED_ENROLLMENT_SHA256; TEST_resetProtectedComposition(); });
  const spawnBody = (name) => ({ derive: record, name, isPublic: true, hasSecrets: false, cpuShare: 0.25, gpuShare: 0 });
  return { legacy, native, enforcement, dp: compositeDp, authority, gate, router, rjournal, host, plain, collected, inventory, nativeInventory,
    client: new IsolationManagerClient({ base: routerBase }), body: spawnBody(DEPLOYMENT), neighbourBody: spawnBody(NEIGHBOUR) };
}
const step = (w) => reconcile({ client: w.client, deployment: { id: DEPLOYMENT, body: w.body } });
const allocated = (rows) => rows.reduce((n, r) => n + (r.memory?.appMiB ?? r.policy?.memMiB), 0);
const splice = (dp, m) => new Promise((resolve) => {
  const s = net.connect(dp.server.address().port, "127.0.0.1"); let got = ""; s.on("error", () => {}); s.setEncoding("latin1"); s.on("data", (d) => { got += d; });
  s.on("connect", () => s.write(`ENCLAVE-SPLICE/1 id=${m.id} app=${m.appId} image=${m.image} runtime=${m.runtimeId} key=${KEY}\n`));
  setTimeout(() => resolve({ s, got: () => got }), 300);
});

test("r7 COMPOSITE: both managers + router accounting + supervisor: queued readiness -> Running permit/renewal -> TCP I/O -> Stop -> exact removal", async (t) => {
  const w = await composite(t);
  // 0. the router's REAL snapshot composes both managers: protected capability visible, shared pools, nothing allocated
  const h0 = await w.plain("GET", "/health");
  assert.equal(h0.status, 200, JSON.stringify(h0.body.cannotStart ?? h0.body.admission));
  assert.equal(h0.body.permitEnforcement.available, true);
  assert.equal(h0.body.memory.allocatedMiB, 0);
  assert.equal(h0.body.desktop.ready, false, "TEST native descriptor: native admission is off (stated in the header)");
  // 1. ordinary unenrolled neighbour through the same router (legacy path, real admission + latch)
  await reconcile({ client: w.client, deployment: { id: NEIGHBOUR, body: w.neighbourBody }, deadlineMs: 50, pollMs: 10 }).catch(() => null);
  const nrow = await waitFor(async () => (await w.plain("GET", "/vms")).body.vms.find((r) => r.name === NEIGHBOUR && !/^pp/.test(r.id)));
  assert.match(nrow.id, /^hv[0-9a-f]{32}$/, "the neighbour is an ordinary legacy instance");
  await waitFor(() => !w.rjournal.pending());
  const neighbourMiB = allocated([nrow]);
  // 2. enrolled deployment, queued: the stage crosses the router's attest -> snapshot -> precheck -> admission -> latch -> forward
  const r1 = await step(w);
  assert.match(r1.reason, /^protected:/);
  const id = await waitFor(() => w.enforcement.journal.instances().find((r) => r.deployment === DEPLOYMENT && r.state === "staged")?.instanceId);
  assert.equal(w.rjournal.pending(), false, "the pending cost was cleared ONLY by the same-epoch reservation (observePending)");
  const rows1 = (await w.plain("GET", "/vms")).body.vms;
  assert.deepEqual(rows1.map((r) => r.id).sort(), [id, nrow.id].sort());
  const h1 = (await w.plain("GET", "/health")).body;
  assert.equal(h1.memory.allocatedMiB, allocated(rows1), "router accounting = both instances");
  assert.ok(h1.memory.allocatedMiB > neighbourMiB, "the protected stage is charged");
  // 3. repeated queued readiness: the SAME instance, no churn
  await waitFor(() => w.legacy.get(id)?.status === "running");
  for (let i = 0; i < 3; i++) assert.match((await step(w)).reason, /readiness-verified/);
  assert.equal(readInv(w.inventory).vms.length, 2, "neighbour + one protected VM");
  // 4. Running: owner-selected witnesses -> gate.install -> boundaries.allow -> manager permit; then a renewal on the next pass
  w.authority.s.state = "running"; w.authority.s.generation = w.enforcement.journal.instance(id).generation;
  const r3 = await step(w);
  assert.equal(r3.action, "adopted", r3.reason); assert.equal(r3.instance.protected.serving, true);
  const d1 = w.enforcement.journal.instance(id).permit.digest;
  assert.equal(d1, w.gate.entries.get(DEPLOYMENT).digest);
  const r4 = await step(w);
  assert.equal(r4.action, "adopted", r4.reason);
  assert.equal(w.collected[1].record.sequence, w.collected[0].record.sequence + 1);
  assert.equal(w.collected.length, 2, "renewal collected a second envelope");
  assert.notEqual(w.enforcement.journal.instance(id).permit.digest, d1, "renewal installed the newer exact permit");
  assert.equal(w.enforcement.journal.instance(id).state, "serving", "renewal kept the same instance serving");
  // 5. useful TCP I/O through the actual router splice under the current permit
  const s = await splice(w.dp, w.legacy.get(id));
  assert.match(s.got(), /^OK/);
  s.s.write("ping-r7\n"); await waitFor(() => s.got().includes("ping-r7"));
  // 6. owner Stop observed by the supervisor -> authority withdrawal -> stream closed, exact removal, accounting released
  w.authority.s.state = "stopped";
  const r5 = await step(w);
  assert.equal(r5.withdrawn, true, r5.reason);
  await waitFor(() => s.s.destroyed || s.s.readableEnded);
  assert.equal(w.enforcement.journal.instance(id).state, "removed");
  const rows2 = (await w.plain("GET", "/vms")).body.vms;
  assert.deepEqual(rows2.map((r) => r.id), [nrow.id], "only the neighbour remains");
  assert.equal((await w.plain("GET", "/health")).body.memory.allocatedMiB, neighbourMiB);
  assert.equal(readInv(w.nativeInventory).vms.length, 0);
  // 7. memory floor: a new queued stage under insufficient host headroom is refused by the router BEFORE any latch or forward
  w.authority.s.state = "queued"; w.host.freeMiB = 1024;
  const r6 = await step(w);
  assert.equal(r6.action, "held");
  assert.equal(w.rjournal.pending(), false, "a floor refusal latches nothing");
  assert.equal(w.enforcement.journal.instances().filter((r) => r.deployment === DEPLOYMENT && r.state !== "removed").length, 0, "nothing staged");
  assert.deepEqual((await w.plain("GET", "/vms")).body.vms.map((r) => r.id), [nrow.id]);
  // the neighbour leaves through the router's ordinary legacy DELETE route (real routing; TEST cleanup)
  assert.equal((await w.plain("DELETE", `/vms/${nrow.id}`)).status, 200);
});

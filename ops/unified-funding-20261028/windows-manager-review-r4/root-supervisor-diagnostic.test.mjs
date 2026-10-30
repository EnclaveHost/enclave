// permit r4 (AUTHORED, NOT RUN). The ACTUAL consuming chain, positively:
//   isolation-lifecycle.reconcile (what host.mjs #isolationReconcile calls) -> protectedSupervisorFor (pinned TEST
//   enrollment) -> R18 createIsolationLifecycleRuntime (ensureStaged/serve/stop) -> ProtectedIsolationClient adapters ->
//   GuestdControl (real HMAC, TCP) -> createProtectedServer/ControlServer -> PermitEnforcement built by compose.mjs
//   composeProtected (the same function main.mjs calls) -> real guard process, real data plane splice.
// TEST and labelled: JSON "Hyper-V" inventory, launcher/readiness doubles, TEST authority snapshot, TEST in-memory r18
// lifecycle journal (NOT the owned r18 journal), in-process journal exclusion. Not Windows/Hyper-V/Base evidence.
// The r18 runtime is imported from the pinned frozen R18 path (read-only reference); its release mapping is pending.
// If isolation-lifecycle stops delegating to the supervisor, the legacy client is used and the protected assertions fail;
// if compose.applyNativeRole stops wrapping spawnProtectedInternal, the native-pin assertions fail.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createHash } from "node:crypto";
import { HyperVPartitionBackend } from "./candidate/control/windows/vbslike/manager/backend.mjs";
import { startManager } from "./candidate/control/windows/vbslike/manager/server.mjs";
import { ProtectedManager } from "./candidate/control/windows/vbslike/manager/protected-manager.mjs";
import { composeProtected, dataLookup, applyNativeRole, selectRole, validatePermitConfig } from "./candidate/control/windows/vbslike/manager/compose.mjs";
import { CONFIG_SCHEMA, TEST_QUALIFICATION } from "./candidate/control/windows/vbslike/manager/permit-enforcement.mjs";
import { openOwnedLog, initializeOwnedLog, TEST_inProcessExclusion } from "./candidate/control/windows/vbslike/manager/win-durable.mjs";
import { openPermitJournal } from "./candidate/control/windows/vbslike/manager/permit-journal.mjs";
import { GuardClient } from "./candidate/control/windows/vbslike/guard/guard-client.mjs";
import { dataPlaneFor } from "./candidate/control/windows/vbslike/datapath/node-bridge.mjs";
import { DeploymentPermitGate } from "./candidate/control/network/deployment-permit-gate.mjs";
import { GuestdControl } from "./candidate/control/isolation/m4/guestd/control-client.mjs";
import { IsolationManagerClient } from "./candidate/control/windows/node/isolation-client.mjs";
import { reconcile, retire } from "./candidate/control/windows/node/isolation-lifecycle.mjs";
import { composition, protectedSupervisorFor, TEST_resetProtectedComposition, ENROLLMENT_SCHEMA } from "./candidate/control/windows/node/protected-supervisor.mjs";
import { PINS, HOST, DEPLOYMENT, KEY, POLICY, vectors, tmp, writeInv, readInv, testLauncher, echoServer, startGuard, selfIdentity, testAuthority, envelope, waitFor } from "./candidate/test/windows-permit/helpers/world.mjs";
import net from "node:net";

const R18 = "/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028/windows-manager-root-review-r4/r18-test-deps/network/deployment-isolation-runtime.mjs";

/** TEST in-memory lifecycle journal with exactly the methods the r18 runtime calls. NOT the owned r18 journal. */
function TEST_lifecycleJournal() {
  const rows = new Map(); const row = (id) => rows.get(id) ?? { sequence: 0, runtime: null, attempts: 0 };
  return { label: "TEST-in-memory-lifecycle-journal",
    read: (id) => ({ ...row(id) }),
    rememberRuntime(id, { instance, generation, now }) { const r = row(id); const prev = r.runtime?.instance === instance ? r.runtime : null;
      r.runtime = { instance, generation, startedAt: prev?.startedAt ?? now }; rows.set(id, r); return r.runtime; },
    retireRuntime(id, instance) { const r = row(id); if (r.runtime?.instance === instance) r.runtime = null; rows.set(id, r); },
    beginAttempt(id) { const r = row(id); r.attempts++; rows.set(id, r); return r.attempts; },
    bumpSequence(id) { const r = row(id); r.sequence++; rows.set(id, r); } };
}

async function world(t, { native = false } = {}) {
  TEST_resetProtectedComposition();
  const dir = tmp(t), { record, component } = vectors();
  const inventory = path.join(dir, "inventory.json"); writeInv(inventory, { vms: [] });
  const relayPort = await echoServer(t);
  const manager = new ProtectedManager({ backend: new HyperVPartitionBackend({ launcher: testLauncher({ file: inventory, relayPort }) }), runtimeId: record.runtimeId,
    fetchComponent: async () => component, judgeReady: async () => ({ status: "running", transportKeySha256: KEY, checks: { document: { verdict: "TEST" } } }) });
  await startManager(manager);
  const jfile = path.join(dir, "permit.log"); initializeOwnedLog(jfile, { purpose: "enclave-manager-permit/1" });
  const log = openOwnedLog(jfile, { purpose: "enclave-manager-permit/1", exclusion: TEST_inProcessExclusion() }); t.after(() => { try { log.release(); } catch {} });
  const g = await startGuard(t, dir, { inventory });
  const guard = await GuardClient.connect({ path: g.socket, key: g.key, identity: { ...selfIdentity(), epoch: manager.epoch } }); t.after(() => guard.close());
  let enforcement = null;
  const dp = dataPlaneFor(dataLookup(manager, () => enforcement));
  await new Promise((r) => dp.server.listen(0, "127.0.0.1", r)); t.after(() => dp.server.close());
  const authority = testAuthority({ now: Date.now });
  const controlKey = crypto.randomBytes(32);
  const removed = [];
  const computeRemover = { label: "TEST-independent-remover", async survey() { return readInv(inventory); },
    async removeById(vmId) { const j = readInv(inventory), n = j.vms.length; j.vms = j.vms.filter((v) => v.vmId !== vmId); writeInv(inventory, j); removed.push(vmId); return n === j.vms.length ? { found: false, removed: false } : { found: true, removed: true }; } };
  const c = await composeProtected({ manager, enforcementConfig: { schema: CONFIG_SCHEMA, pins: PINS, host: HOST, maxStagingMs: 60_000, derivations: ["enclave-catalog-bundle/1"], qualification: TEST_QUALIFICATION, retryMs: 200 },
    journal: openPermitJournal(log), guard, authority, dataPlane: dp, computeRemover, controlKey });
  enforcement = c.enforcement;
  await new Promise((r) => c.server.listen(0, "127.0.0.1", r)); t.after(async () => { c.server.closeAllConnections(); await new Promise((r) => c.server.close(r)); });
  const base = `http://127.0.0.1:${c.server.address().port}`;
  // the node's pinned enrollment policy (TEST file, hash-pinned exactly as production)
  const keyFile = path.join(dir, "control.key"); fs.writeFileSync(keyFile, controlKey.toString("hex"), { mode: 0o600 });
  const pol = Buffer.from(JSON.stringify({ schema: ENROLLMENT_SCHEMA, host: HOST, manager: base, controlKeyFile: keyFile, deployments: [DEPLOYMENT], stagingMs: 30_000 }));
  const polFile = path.join(dir, "enrollment.json"); fs.writeFileSync(polFile, pol);
  const env = { ENCLAVE_PROTECTED_ENROLLMENT: polFile, ENCLAVE_PROTECTED_ENROLLMENT_SHA256: createHash("sha256").update(pol).digest("hex") };
  // the supervisor's OWN gate (separate TEST journal) and the r18 runtime, bound to the protected adapters
  const sfile = path.join(dir, "supervisor-permit.log"); initializeOwnedLog(sfile, { purpose: "enclave-manager-permit/1" });
  const slog = openOwnedLog(sfile, { purpose: "enclave-manager-permit/1", exclusion: TEST_inProcessExclusion() }); t.after(() => { try { slog.release(); } catch {} });
  const sj = openPermitJournal(slog);
  const gate = new DeploymentPermitGate({ pins: PINS, journal: sj, hostAuthority: sj.hostAuthority });
  const { createIsolationLifecycleRuntime } = await import(R18);
  const lj = TEST_lifecycleJournal();
  const collected = [];
  composition.collect = async (rec) => { const e = await envelope(rec); collected.push(e); return e; };     // owner-selected TEST witnesses
  composition.openRuntime = async ({ host, bind }) => {
    const a = bind({ gate, pins: PINS });
    const runtime = createIsolationLifecycleRuntime({ client: a.client, gate, journal: lj, plans: a.plans, readiness: a.readiness, collectPermit: a.collectPermit, boundaries: a.boundaries, host });
    return { runtime, gate, pins: PINS, snapshot: async (id) => { const ctx = await authority.read(id);
      return { ...ctx, assignment: { ...ctx.assignment, revision: 1 }, hostAuthorityEvidence: ctx.hostAuthority, profile: PINS.profile }; } };
  };
  const legacyClient = new IsolationManagerClient({ base });
  Object.assign(process.env, env); t.after(() => { delete process.env.ENCLAVE_PROTECTED_ENROLLMENT; delete process.env.ENCLAVE_PROTECTED_ENROLLMENT_SHA256; TEST_resetProtectedComposition(); });
  const body = { derive: record, name: DEPLOYMENT, isPublic: true, hasSecrets: false };
  return { manager, enforcement, dp, authority, legacyClient, inventory, body, base, removed, collected, gate, controlKey };
}

const splice = (dp, m) => new Promise((resolve) => {
  const c = net.connect(dp.server.address().port, "127.0.0.1"); let got = ""; c.on("error", () => {}); c.setEncoding("latin1"); c.on("data", (d) => { got += d; });
  c.on("connect", () => c.write(`ENCLAVE-SPLICE/1 id=${m.id} app=${m.appId} image=${m.image} runtime=${m.runtimeId} key=${KEY}\n`));
  setTimeout(() => resolve({ c, got: () => got }), 300);
});

test("R4 DIRECT: host lifecycle -> supervisor -> r18 runtime -> GuestdControl -> manager: stage, readiness, permit, I/O, Stop, removal", async (t) => {
  const w = await world(t);
  assert.ok(await protectedSupervisorFor(w.legacyClient), "the host's real client origin selects the enrolled supervisor");
  // 1. queued: the owned stage (no legacy spawn); held until the owner's Running assignment
  const r1 = await reconcile({ client: w.legacyClient, deployment: { id: DEPLOYMENT, body: w.body } });
  assert.equal(r1.action, "held"); assert.match(r1.reason, /^protected:/);
  const id = await waitFor(() => w.enforcement.journal.instances().find((r) => r.deployment === DEPLOYMENT && r.state === "staged")?.instanceId);
  assert.match(id, /^pp[0-9a-f]{32}$/, "the stage went through the authenticated protected route");
  await waitFor(() => w.manager.get(id)?.status === "running");
  const r2 = await reconcile({ client: w.legacyClient, deployment: { id: DEPLOYMENT, body: w.body } });
  console.log("ROOT_READY_DIAGNOSTIC", JSON.stringify({result:r2, record:w.enforcement.journal.instance(id), manager:w.manager.get(id)}));
  assert.match(r2.reason, /readiness-verified/);
  // 2. running: collected envelope carried through boundaries.allow to the manager's own gate
  w.authority.s.state = "running"; w.authority.s.generation = w.enforcement.journal.instance(id).generation;
  const r3 = await reconcile({ client: w.legacyClient, deployment: { id: DEPLOYMENT, body: w.body } });
  assert.equal(r3.action, "adopted", r3.reason); assert.equal(r3.instance.protected.serving, true);
  assert.equal(w.collected.length, 1);
  const m = w.manager.get(id);
  assert.equal(w.enforcement.journal.instance(id).permit.digest, w.gate.entries.get(DEPLOYMENT).digest, "the manager accepted exactly the supervisor gate's envelope");
  const s = await splice(w.dp, m); assert.match(s.got(), /^OK/, "usable I/O under the permit");
  // 3. owner Stop through retire (the host's real retire path): stream closed, exact compute confirmed gone
  const gone = await retire({ client: w.legacyClient, deployment: { id: DEPLOYMENT } });
  assert.equal(gone.removed, true, gone.reason);
  await waitFor(() => s.c.destroyed || s.c.readableEnded);
  assert.equal(readInv(w.inventory).vms.some((v) => v.notes?.includes(id)), false);
  assert.equal(w.enforcement.journal.instance(id).state, "removed");
});

test("R4 legacy neighbour: an unenrolled deployment keeps the legacy path (no protected stage)", async (t) => {
  const w = await world(t);
  const other = "0x" + "77".repeat(32);
  const r = await reconcile({ client: w.legacyClient, deployment: { id: other, body: { ...w.body, name: other } }, deadlineMs: 50, pollMs: 10 });
  assert.notEqual(r.reason?.startsWith?.("protected:"), true);
  assert.equal(w.enforcement.journal.instances().some((x) => x.deployment === other), false);
});

test("R4 native role keeps its pins on the protected stage; general role never gets them", async (t) => {
  assert.throws(() => selectRole({ permitConfigured: true }), /explicit ENCLAVE_MANAGER_ROLE/);
  assert.equal(selectRole({}), "native");
  const cfg = { enforcement: {}, journal: "x", storage: "x", controlKeyFile: "x", guard: {}, port: 8095, dataPort: 8096 };
  assert.doesNotThrow(() => validatePermitConfig(cfg, { role: "native", port: 8095, dataPort: "8096" }));
  assert.throws(() => validatePermitConfig(cfg, { role: "general", port: 8095, dataPort: "8096" }));
  const w = await world(t);
  const pins = { deployment: "0x" + "99".repeat(32), catalogApp: "x", catalogVersion: "1", cid: "c", runtimeId: "r", profileSha256: "p" };
  applyNativeRole(w.manager, pins, { port: 8095, dataPort: "8096" });
  const r = await w.enforcement.stage({ schema: "enclave-protected-stage/1", deployment: DEPLOYMENT, stagingMs: 5000, spawn: structuredClone(w.body) }).catch((e) => e);
  if (r?.instanceId) await waitFor(() => w.enforcement.journal.instance(r.instanceId)?.state !== "staging");
  assert.ok(r?.instanceId ? w.enforcement.journal.instance(r.instanceId).state !== "staged" : true, "a protected stage differing from the native pins never stages");
  assert.ok(w.manager.health().vmScope, "native scope marker applied in the protected native role");
});

test("R4 DELETE through an unreadable journal withdraws first and answers 500 (actual MAC/TCP)", async (t) => {
  const w = await world(t);
  await reconcile({ client: w.legacyClient, deployment: { id: DEPLOYMENT, body: w.body } });
  const id = await waitFor(() => w.enforcement.journal.instances().find((r) => r.state === "staged")?.instanceId);
  const ctl = new GuestdControl(w.base, w.controlKey);
  const read = w.enforcement.journal.instance, close = w.dp.closeInstance; let closed = 0;
  w.enforcement.journal.instance = () => { throw Error("TEST unreadable"); };
  w.dp.closeInstance = function (...a) { closed++; return close.apply(this, a); };
  let r; try { r = await ctl.request("DELETE", `/vms/${id}`, undefined, { idempotent: true }); }
  finally { w.enforcement.journal.instance = read; w.dp.closeInstance = close; await w.enforcement.withdraw(id, "TEST cleanup").catch(() => {}); }
  assert.equal(r.status, 500); assert.ok(closed > 0);
});

// Actual lifecycle dispatch with a pinned enrollment; TEST alternate client records only attempted legacy lookup.
test("ROOT protected enrollment does not fall through to legacy on manager-origin change", async t=>{
 const w=await world(t);let calls=0;
 const other={base:'http://127.0.0.1:9',findByName:async()=>{calls++;throw Error('TEST legacy lookup');}};
 await reconcile({client:other,deployment:{id:DEPLOYMENT,body:w.body},deadlineMs:1}).catch(()=>{});
 assert.equal(calls,0,'enrolled deployment reached legacy lookup on different origin');
});

// permit r7 (AUTHORED, NOT RUN). The ACTUAL supervisor consuming Stop / Offline / unknown authority / late raw stage:
// isolation-lifecycle.reconcile -> protectedSupervisorFor -> ProtectedSupervisor.reconcile (r7: existing authority consumed BEFORE
// capability/new-work admission) -> r18 createIsolationLifecycleRuntime (candidate copy) revokeAuthority/revokeHostAuthority/fence ->
// DeploymentPermitGate.revoke -> ProtectedIsolationClient -> GuestdControl (real MAC/TCP) -> createProtectedServer/ControlServer ->
// PermitEnforcement (composeProtected) -> real guard process.
// world() is the ROOT r6 corrected stage fixture world (evidence/root-r6/root-r6-stage-fixture.test.mjs) with portable relative
// imports, the owned obligation store, and two labelled TEST interpositions: `wrap` (adapter interposition: delayed spawn) and
// `degraded` (the supervisor's GET /health answered 503 to model an unavailable manager capability; every other request is the
// real MAC'd exchange). live() is the FULL inventory of the exclusive TEST world (root correction), not a Notes regex.
// TEST and labelled: JSON "Hyper-V" inventory, launcher/readiness doubles, TEST authority snapshot and witnesses, TEST in-memory r18
// lifecycle journal, in-process log exclusion. Not Windows/Hyper-V/Base evidence.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createHash } from "node:crypto";
import { HyperVPartitionBackend } from "../../control/windows/vbslike/manager/backend.mjs";
import { startManager } from "../../control/windows/vbslike/manager/server.mjs";
import { ProtectedManager } from "../../control/windows/vbslike/manager/protected-manager.mjs";
import { composeProtected, dataLookup } from "../../control/windows/vbslike/manager/compose.mjs";
import { CONFIG_SCHEMA, TEST_QUALIFICATION } from "../../control/windows/vbslike/manager/permit-enforcement.mjs";
import { openOwnedLog, initializeOwnedLog, TEST_inProcessExclusion } from "../../control/windows/vbslike/manager/win-durable.mjs";
import { openPermitJournal } from "../../control/windows/vbslike/manager/permit-journal.mjs";
import { GuardClient } from "../../control/windows/vbslike/guard/guard-client.mjs";
import { dataPlaneFor } from "../../control/windows/vbslike/datapath/node-bridge.mjs";
import { DeploymentPermitGate } from "../../control/network/deployment-permit-gate.mjs";
import { createIsolationLifecycleRuntime } from "../../control/network/deployment-isolation-runtime.mjs";
import { GuestdControl, parseKey } from "../../control/isolation/m4/guestd/control-client.mjs";
import { IsolationManagerClient } from "../../control/windows/node/isolation-client.mjs";
import { reconcile } from "../../control/windows/node/isolation-lifecycle.mjs";
import { ownedObligationStore, OBLIGATION_PURPOSE } from "../../control/windows/node/protected-isolation.mjs";
import { composition, TEST_resetProtectedComposition, ENROLLMENT_SCHEMA } from "../../control/windows/node/protected-supervisor.mjs";
import { PINS, HOST, DEPLOYMENT, vectors, tmp, writeInv, readInv, testLauncher, echoServer, startGuard, selfIdentity, testAuthority, envelope, waitFor, KEY } from "./helpers/world.mjs";

function TEST_lifecycleJournal() {
  const rows = new Map(); const row = (id) => rows.get(id) ?? { sequence: 0, runtime: null, attempts: 0 };
  return { label: "TEST-in-memory-lifecycle-journal", read: (id) => ({ ...row(id) }),
    rememberRuntime(id, { instance, generation, now }) { const r = row(id); const prev = r.runtime?.instance === instance ? r.runtime : null;
      r.runtime = { instance, generation, startedAt: prev?.startedAt ?? now }; rows.set(id, r); return r.runtime; },
    retireRuntime(id, instance) { const r = row(id); if (r.runtime?.instance === instance) r.runtime = null; rows.set(id, r); },
    beginAttempt(id) { const r = row(id); r.attempts++; rows.set(id, r); return r.attempts; },
    bumpSequence(id) { const r = row(id); r.sequence++; rows.set(id, r); } };
}

async function world(t, { wrap = (a) => a } = {}) {
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
  const computeRemover = { label: "TEST-independent-remover", async survey() { return readInv(inventory); },
    async removeById(vmId) { const j = readInv(inventory), n = j.vms.length; j.vms = j.vms.filter((v) => v.vmId !== vmId); writeInv(inventory, j); return n === j.vms.length ? { found: false, removed: false } : { found: true, removed: true }; } };
  const c = await composeProtected({ manager, enforcementConfig: { schema: CONFIG_SCHEMA, pins: PINS, host: HOST, maxStagingMs: 60_000, derivations: ["enclave-catalog-bundle/1"], qualification: TEST_QUALIFICATION, retryMs: 200 },
    journal: openPermitJournal(log), guard, authority, dataPlane: dp, computeRemover, controlKey });
  enforcement = c.enforcement;
  await new Promise((r) => c.server.listen(0, "127.0.0.1", r)); t.after(async () => { c.server.closeAllConnections(); await new Promise((r) => c.server.close(r)); });
  const base = `http://127.0.0.1:${c.server.address().port}`;
  const keyFile = path.join(dir, "control.key"); fs.writeFileSync(keyFile, controlKey.toString("hex"), { mode: 0o600 });
  const pol = Buffer.from(JSON.stringify({ schema: ENROLLMENT_SCHEMA, host: HOST, manager: base, controlKeyFile: keyFile, deployments: [DEPLOYMENT], stagingMs: 30_000 }));
  const polFile = path.join(dir, "enrollment.json"); fs.writeFileSync(polFile, pol);
  const sfile = path.join(dir, "supervisor-permit.log"); initializeOwnedLog(sfile, { purpose: "enclave-manager-permit/1" });
  const slog = openOwnedLog(sfile, { purpose: "enclave-manager-permit/1", exclusion: TEST_inProcessExclusion() }); t.after(() => { try { slog.release(); } catch {} });
  const sj = openPermitJournal(slog);
  const gate = new DeploymentPermitGate({ pins: PINS, journal: sj, hostAuthority: sj.hostAuthority });
  const lj = TEST_lifecycleJournal(); let runtime = null;
  const ofile = path.join(dir, "protected-obligations.log"); initializeOwnedLog(ofile, { purpose: OBLIGATION_PURPOSE });
  const olog = openOwnedLog(ofile, { purpose: OBLIGATION_PURPOSE, exclusion: TEST_inProcessExclusion() }); t.after(() => { try { olog.release(); } catch {} });
  const state = { degraded: false };
  composition.hostId = HOST;
  composition.store = ownedObligationStore(olog);
  composition.collect = async (rec) => envelope(rec);
  // TEST transport interposition (labelled): only the supervisor's GET /health can be answered 503; everything else is the real exchange
  composition.controlFor = (p) => { const real = new GuestdControl(p.manager, parseKey(fs.readFileSync(p.controlKeyFile, "utf8")));
    return { request: (m, u, ...rest) => (state.degraded && m === "GET" && u === "/health" ? Promise.resolve({ status: 503, body: { error: "TEST capability unavailable" } }) : real.request(m, u, ...rest)) }; };
  composition.openRuntime = async ({ host, bind }) => {
    const a = wrap(bind({ gate, pins: PINS }));
    runtime = createIsolationLifecycleRuntime({ client: a.client, gate, journal: lj, plans: a.plans, readiness: a.readiness, collectPermit: a.collectPermit, boundaries: a.boundaries, host });
    return { runtime, gate, pins: PINS, handoff: { owns: () => true, activated: () => true, why: () => null, activate: async () => [], newWorkRefusal: () => null, label: "TEST fixture (r9): route handoff pre-activated; the real dispatch handoff is r9-real-owned-factory" }, snapshot: async (id) => { const ctx = await authority.read(id);
      return { ...ctx, id, blockAt: ctx.assignment.observedAt * 1000, blockHash: ctx.assignment.blockHash, authorityTier: ctx.assignment.authorityTier, admitted: ctx.hostAdmitted, funded: ctx.assignment.funded, verified: ctx.assignment.proofVerified, assignment: { ...ctx.assignment, revision: 1 }, hostAuthorityEvidence: ctx.hostAuthority, profile: PINS.profile }; } };
  };
  process.env.ENCLAVE_PROTECTED_ENROLLMENT = polFile;
  process.env.ENCLAVE_PROTECTED_ENROLLMENT_SHA256 = createHash("sha256").update(pol).digest("hex");
  t.after(() => { delete process.env.ENCLAVE_PROTECTED_ENROLLMENT; delete process.env.ENCLAVE_PROTECTED_ENROLLMENT_SHA256; TEST_resetProtectedComposition(); });
  const body = { derive: record, name: DEPLOYMENT, isPublic: true, hasSecrets: false };
  return { manager, enforcement, authority, legacyClient: new IsolationManagerClient({ base }), inventory, body, gate, state, runtime: () => runtime };
}
const stagedId = (w) => waitFor(() => w.enforcement.journal.instances().find((r) => r.deployment === DEPLOYMENT && r.state === "staged")?.instanceId);
const live = (w) => readInv(w.inventory).vms;   // the exclusive TEST world's full inventory (root correction)
const step = (w) => reconcile({ client: w.legacyClient, deployment: { id: DEPLOYMENT, body: w.body } });
async function readyStaged(w) {
  await step(w); const id = await stagedId(w);
  await waitFor(() => w.manager.get(id)?.status === "running");
  assert.match((await step(w)).reason, /readiness-verified/);
  assert.equal(live(w).length, 1);
  return id;
}

test("ROOT (carried, root r6 0/1) supervisor observes a stopped assignment and retires existing staged compute", async (t) => {
  const w = await world(t); const id = await readyStaged(w);
  try {
    w.authority.s.state = "stopped";
    const r = await step(w);
    assert.match(r.reason, /authority withdrawn \(assignment is stopped\); compute confirmed absent/);
    assert.equal(w.enforcement.journal.instance(id).state, "removed", "actual supervisor must dispatch observed Stop to retirement, not only return held");
    assert.equal(live(w).length, 0);
    assert.deepEqual(w.gate.stagedOn(HOST), []);
    assert.equal(w.gate.withdrawalFailures().length, 0);
  } finally { await w.enforcement.withdraw(id, "TEST cleanup").catch(() => {}); }
});

test("r7 Stop is consumed even when the manager capability (new-work admission) is unavailable", async (t) => {
  const w = await world(t); const id = await readyStaged(w);
  try {
    w.state.degraded = true;                       // GET /health -> 503 from here on (TEST)
    w.authority.s.state = "stopped";
    const r = await step(w);
    assert.doesNotMatch(r.reason, /capability/, "capability is never consulted before an authenticated Stop");
    assert.equal(w.enforcement.journal.instance(id).state, "removed");
    assert.equal(live(w).length, 0);
    w.authority.s.state = "queued";                // new work under the unavailable capability: held, nothing started
    assert.match((await step(w)).reason, /manager capability|enforcement unavailable/);
    assert.equal(live(w).length, 0);
  } finally { await w.enforcement.withdraw(id, "TEST cleanup").catch(() => {}); }
});

test("r7 canonical Offline (proof-verified, this host) retires staged compute through the actual supervisor", async (t) => {
  const w = await world(t); const id = await readyStaged(w);
  try {
    w.authority.s.online = false;
    const r = await step(w);
    assert.match(r.reason, /canonical host Offline\); compute confirmed absent and boundary acknowledged/);
    assert.equal(w.enforcement.journal.instance(id).state, "removed");
    assert.equal(live(w).length, 0);
    assert.deepEqual(w.gate.stagedOn(HOST), []);
  } finally { await w.enforcement.withdraw(id, "TEST cleanup").catch(() => {}); }
});

test("r7 unknown authority FENCES and keeps the staged obligation (no invented Stop); restored authority reuses the SAME instance", async (t) => {
  const w = await world(t); const id = await readyStaged(w);
  try {
    w.authority.s.fail = "TEST authority unreadable";
    assert.match((await step(w)).reason, /authority snapshot unavailable: TEST authority unreadable; fenced/);
    assert.equal(w.enforcement.journal.instance(id).state, "staged", "unknown is not a Stop: compute and obligation kept");
    assert.equal(live(w).length, 1);
    assert.deepEqual(w.gate.stagedOn(HOST), [DEPLOYMENT]);
    w.authority.s.fail = null;
    assert.match((await step(w)).reason, /readiness-verified/);
    assert.equal(w.enforcement.journal.instances().filter((r) => r.deployment === DEPLOYMENT && r.state === "staged").map((r) => r.instanceId).join(), id, "no restage churn");
  } finally { await w.enforcement.withdraw(id, "TEST cleanup").catch(() => {}); }
});

test("r7 late raw stage: a Stop observed while the owned stage is in flight waits for it, withdraws it, and only then acknowledges", async (t) => {
  let release, spawned = false;
  const gateSpawn = new Promise((r) => { release = r; });
  const w = await world(t, { wrap: (a) => { const s = a.client.spawn; a.client.spawn = async (b) => { spawned = true; await gateSpawn; return s(b); }; return a; } });
  const first = step(w);
  await waitFor(() => spawned);
  w.authority.s.state = "stopped";
  const stopping = step(w);                        // actual supervisor consumption while the raw stage is still owned and pending
  await new Promise((r) => setTimeout(r, 100));
  release();                                       // the raw stage now executes AFTER authority was withdrawn
  await first;
  const r = await stopping;
  assert.equal(r.withdrawn, true, `withdrawal must complete with terminal proof: ${r.reason}`);
  assert.equal(live(w).length, 0, "the late instance was owned and removed, not orphaned");
  for (const x of w.enforcement.journal.instances().filter((x) => x.deployment === DEPLOYMENT)) assert.notEqual(x.state, "staged");
});

test("ROOT r6 late spawn (carried, root r6 0/1): revokeHostAuthority resolves only after the late instance is withdrawn and the hold acknowledged", async (t) => {
  let release, spawned = false;
  const gateSpawn = new Promise((r) => { release = r; });
  const w = await world(t, { wrap: (a) => { const s = a.client.spawn; a.client.spawn = async (b) => { spawned = true; await gateSpawn; return s(b); }; return a; } });
  const first = step(w);
  await waitFor(() => spawned);
  const revoking = w.runtime().revokeHostAuthority(DEPLOYMENT, {});
  release();
  await first;
  assert.deepEqual(await revoking, { absent: true, held: true });
  assert.equal(live(w).length, 0);
  for (const r of w.enforcement.journal.instances().filter((r) => r.deployment === DEPLOYMENT)) assert.notEqual(r.state, "staged");
});

// permit r6 (AUTHORED, NOT RUN). Purpose-specific fence vs authority withdrawal through the ACTUAL chain:
// isolation-lifecycle.reconcile -> protectedSupervisorFor -> r18 createIsolationLifecycleRuntime (candidate copy, r6 edited)
// -> ProtectedIsolationClient -> GuestdControl (real MAC/TCP) -> createProtectedServer/ControlServer -> PermitEnforcement
// (composeProtected) -> real guard process. The world() below is the ROOT r5 evidence world (evidence/root-r5/
// root-stage-revocation.test.mjs) carried verbatim except for the `wrap` hook (TEST adapter interposition, labelled).
// TEST and labelled: JSON "Hyper-V" inventory, launcher/readiness doubles, TEST authority snapshot and witnesses, TEST
// in-memory r18 lifecycle journal, in-process journal exclusion, TEST hung boundary and TEST delayed spawn. Not Windows/
// Hyper-V/Base evidence and not a Running/serving composite proof.
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
import { IsolationManagerClient } from "../../control/windows/node/isolation-client.mjs";
import { reconcile } from "../../control/windows/node/isolation-lifecycle.mjs";
import { ownedObligationStore, OBLIGATION_PURPOSE } from "../../control/windows/node/protected-isolation.mjs";
import { composition, TEST_resetProtectedComposition, ENROLLMENT_SCHEMA } from "../../control/windows/node/protected-supervisor.mjs";
import { PINS, HOST, DEPLOYMENT, KEY, vectors, tmp, writeInv, readInv, testLauncher, echoServer, startGuard, selfIdentity, testAuthority, envelope, waitFor } from "./helpers/world.mjs";

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
  // r6: the OWNED obligation store (win-durable log, TEST in-process exclusion), not the plain JSON file
  const ofile = path.join(dir, "protected-obligations.log"); initializeOwnedLog(ofile, { purpose: OBLIGATION_PURPOSE });
  const olog = openOwnedLog(ofile, { purpose: OBLIGATION_PURPOSE, exclusion: TEST_inProcessExclusion() }); t.after(() => { try { olog.release(); } catch {} });
  composition.hostId = HOST;
  composition.store = ownedObligationStore(olog);
  composition.collect = async (rec) => envelope(rec);
  composition.openRuntime = async ({ host, bind }) => {
    const a = wrap(bind({ gate, pins: PINS }));
    runtime = createIsolationLifecycleRuntime({ client: a.client, gate, journal: lj, plans: a.plans, readiness: a.readiness, collectPermit: a.collectPermit, boundaries: a.boundaries, host });
    return { runtime, gate, pins: PINS, snapshot: async (id) => { const ctx = await authority.read(id);
      return { ...ctx, id, blockAt: ctx.assignment.observedAt * 1000, blockHash: ctx.assignment.blockHash, authorityTier: ctx.assignment.authorityTier, admitted: ctx.hostAdmitted, funded: ctx.assignment.funded, verified: ctx.assignment.proofVerified, assignment: { ...ctx.assignment, revision: 1 }, hostAuthorityEvidence: ctx.hostAuthority, profile: PINS.profile }; } };
  };
  process.env.ENCLAVE_PROTECTED_ENROLLMENT = polFile;
  process.env.ENCLAVE_PROTECTED_ENROLLMENT_SHA256 = createHash("sha256").update(pol).digest("hex");
  t.after(() => { delete process.env.ENCLAVE_PROTECTED_ENROLLMENT; delete process.env.ENCLAVE_PROTECTED_ENROLLMENT_SHA256; TEST_resetProtectedComposition(); });
  const body = { derive: record, name: DEPLOYMENT, isPublic: true, hasSecrets: false };
  return { manager, enforcement, authority, legacyClient: new IsolationManagerClient({ base }), inventory, body, gate, runtime: () => runtime };
}
const stagedId = (w) => waitFor(() => w.enforcement.journal.instances().find((r) => r.deployment === DEPLOYMENT && r.state === "staged")?.instanceId);
const live = (w) => readInv(w.inventory).vms.filter((v) => /pp[0-9a-f]{32}/.test(String(v.notes ?? "")));
const step = (w) => reconcile({ client: w.legacyClient, deployment: { id: DEPLOYMENT, body: w.body } });

test("r6 POSITIVE: repeated queued readiness keeps ONE staged instance (routine fence is nondestructive)", async (t) => {
  const w = await world(t);
  await step(w); const id = await stagedId(w);
  try {
    await waitFor(() => w.manager.get(id)?.status === "running");
    for (let i = 0; i < 3; i++) assert.match((await step(w)).reason, /readiness-verified/);
    assert.equal(w.enforcement.journal.instance(id).state, "staged");
    assert.deepEqual(live(w).length, 1, "no restage churn: exactly the one staged VM");
    assert.equal(w.gate.stagedOn(HOST).includes(DEPLOYMENT), true, "staged compute stays OWNED (host-bound) across routine fences");
  } finally { await w.enforcement.withdraw(id, "TEST cleanup"); }
});

test("ROOT (carried, r5 evidence 0/1) explicit authority revocation withdraws an owned ready staged instance promptly", async (t) => {
  const w = await world(t);
  await step(w); const id = await stagedId(w);
  try {
    await waitFor(() => w.manager.get(id)?.status === "running");
    assert.match((await step(w)).reason, /readiness-verified/);
    w.authority.s.online = false; w.authority.s.admitted = false;
    const proof = await w.runtime().revokeHostAuthority(DEPLOYMENT, { hostAuthorityEvidence: (await w.authority.read(DEPLOYMENT)).hostAuthority });
    assert.deepEqual(proof, { absent: true, held: true }, "revocation resolves only on CONFIRMED absence + acknowledged hold (stronger than fence)");
    assert.equal(w.enforcement.journal.instance(id).state, "removed");
    assert.equal(live(w).length, 0);
    assert.equal(w.gate.stagedOn(HOST).length, 0);
  } finally { await w.enforcement.withdraw(id, "TEST cleanup").catch(() => {}); }
});

test("r6 NEGATIVE: a HUNG boundary acknowledgment never delays staged compute retirement; the revocation still reports it", async (t) => {
  let hang = false;
  const w = await world(t, { wrap: (a) => { const h = a.boundaries.hold; a.boundaries.hold = (...x) => (hang ? new Promise(() => {}) : h(...x)); return a; } });
  await step(w); const id = await stagedId(w);
  try {
    await waitFor(() => w.manager.get(id)?.status === "running");
    assert.match((await step(w)).reason, /readiness-verified/);
    hang = true;   // TEST hung boundary from here on
    const revoking = w.runtime().revokeHostAuthority(DEPLOYMENT, {});
    await waitFor(() => w.enforcement.journal.instance(id).state === "removed", 1500);   // well before the 3000 ms boundary timeout
    assert.equal(live(w).length, 0);
    await assert.rejects(revoking, /timed out|not acknowledged/, "an unacknowledged hold is never reported as a completed revocation");
  } finally { await w.enforcement.withdraw(id, "TEST cleanup").catch(() => {}); }
});

test("r6 NEGATIVE: a LATE spawn that completes after revocation is withdrawn before the revocation confirms absence", async (t) => {
  let release, spawned = false;
  const gateSpawn = new Promise((r) => { release = r; });
  const w = await world(t, { wrap: (a) => { const s = a.client.spawn; a.client.spawn = async (b) => { spawned = true; await gateSpawn; return s(b); }; return a; } });
  const first = step(w);
  await waitFor(() => spawned);
  const revoking = w.runtime().revokeHostAuthority(DEPLOYMENT, {});
  release();   // the raw stage now executes AFTER authority was withdrawn
  await first;
  assert.deepEqual(await revoking, { absent: true, held: true });
  assert.equal(live(w).length, 0, "the late instance was owned and removed, not orphaned");
  for (const r of w.enforcement.journal.instances().filter((r) => r.deployment === DEPLOYMENT)) assert.notEqual(r.state, "staged");
});

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
import { HyperVPartitionBackend } from "./candidate/control/windows/vbslike/manager/backend.mjs";
import { startManager } from "./candidate/control/windows/vbslike/manager/server.mjs";
import { ProtectedManager } from "./candidate/control/windows/vbslike/manager/protected-manager.mjs";
import { composeProtected, dataLookup } from "./candidate/control/windows/vbslike/manager/compose.mjs";
import { CONFIG_SCHEMA, TEST_QUALIFICATION } from "./candidate/control/windows/vbslike/manager/permit-enforcement.mjs";
import { openOwnedLog, initializeOwnedLog, TEST_inProcessExclusion } from "./candidate/control/windows/vbslike/manager/win-durable.mjs";
import { openPermitJournal } from "./candidate/control/windows/vbslike/manager/permit-journal.mjs";
import { GuardClient } from "./candidate/control/windows/vbslike/guard/guard-client.mjs";
import { dataPlaneFor } from "./candidate/control/windows/vbslike/datapath/node-bridge.mjs";
import { DeploymentPermitGate } from "./candidate/control/network/deployment-permit-gate.mjs";
import { createIsolationLifecycleRuntime } from "./candidate/control/network/deployment-isolation-runtime.mjs";
import { GuestdControl, parseKey } from "./candidate/control/isolation/m4/guestd/control-client.mjs";
import { IsolationManagerClient } from "./candidate/control/windows/node/isolation-client.mjs";
import { reconcile } from "./candidate/control/windows/node/isolation-lifecycle.mjs";
import { ownedObligationStore, OBLIGATION_PURPOSE } from "./candidate/control/windows/node/protected-isolation.mjs";
import { composition, protectedSupervisorFor, TEST_resetProtectedComposition, ENROLLMENT_SCHEMA } from "./candidate/control/windows/node/protected-supervisor.mjs";
import { PINS, HOST, DEPLOYMENT, vectors, tmp, writeInv, readInv, testLauncher, echoServer, startGuard, selfIdentity, testAuthority, envelope, waitFor, KEY } from "./candidate/test/windows-permit/helpers/world.mjs";

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
  const state = { degraded: false, loseStageReply: false, accepted: null };
  composition.hostId = HOST;
  composition.store = ownedObligationStore(olog);
  composition.collect = async (rec) => envelope(rec);
  // TEST transport interposition (labelled): only the supervisor's GET /health can be answered 503; everything else is the real exchange
  composition.controlFor = (p) => { const real = new GuestdControl(p.manager, parseKey(fs.readFileSync(p.controlKeyFile, "utf8")));
    return { request: async (m,u,...rest) => {
      const out=await real.request(m,u,...rest);
      if(state.loseStageReply && m==='POST' && u==='/protected/vms'){
       assert.equal(out.status,202);state.accepted=out.body.instanceId;olog.release();throw Object.assign(Error('TEST processed stage reply lost after owner release'),{mayHaveExecuted:true});
      }return out;
    } }; };
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


test('ROOT supervisor owns unknown processed stage through owner loss and reconciles exact removal',async t=>{
 const w=await world(t);w.state.loseStageReply=true;
 try{
  await step(w);assert.ok(w.state.accepted,'real manager accepted exactly one stage');
  const sup=await protectedSupervisorFor(w.legacyClient);
  assert.ok(sup.client.ownerLost);assert.equal(sup.client.unknownStages.size,1,'raw op retained');
  await step(w);await new Promise(r=>setTimeout(r,500));
  assert.equal(w.enforcement.journal.instance(w.state.accepted).state,'removed','owner-loss reconcile must retire unknown accepted raw operation, not report zero pending stages');
  assert.equal(live(w).length,0);
 }finally{if(w.state.accepted)await w.enforcement.withdraw(w.state.accepted,'TEST exact cleanup').catch(()=>{});}
});

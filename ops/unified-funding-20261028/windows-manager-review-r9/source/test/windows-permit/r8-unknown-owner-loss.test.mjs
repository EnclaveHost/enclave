// permit r8 (AUTHORED, NOT RUN). Carried ROOT r7 regression root-unknown-owner-loss.test.mjs (evidence/root-r7, 1 FAIL there: the
// processed stage stayed 'staged') with portable relative imports and the root world() verbatim except imports; strengthened:
//   A. executed raw stage, reply lost, obligation owner released: the ACTUAL supervisor's next reconcile resolves the operation outcome,
//      retires the exact instance (manager journal 'removed', TEST inventory empty), reports the durable pre-send record as NOT
//      discharged, and a COLD owner (new handle on the same log) discharges it from the manager's authenticated outcome.
//   B. unseen raw stage (dropped before reaching the manager), owner released: the next reconcile durably CANCELS the operation at the
//      manager; a late arrival of the original operation id is refused; nothing staged.
//   C. hung boundary hold during retirement: compute removal still completes (bounded hold, removal independent of its answer).
// Chain: isolation-lifecycle.reconcile -> protectedSupervisorFor -> ProtectedSupervisor -> r18 createIsolationLifecycleRuntime (candidate
// copy) -> DeploymentPermitGate -> ProtectedIsolationClient -> GuestdControl (real MAC/TCP) -> composeProtected ControlServer ->
// PermitEnforcement -> real guard process.
// TEST and labelled: JSON "Hyper-V" inventory, launcher/readiness doubles, TEST authority snapshot and witnesses, TEST in-memory r18
// lifecycle journal, in-process log exclusion, and the transport interpositions in controlFor (lost reply / dropped send / hung hold).
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
import { ProtectedIsolationClient, ownedObligationStore, OBLIGATION_PURPOSE, STAGE_SCHEMA } from "../../control/windows/node/protected-isolation.mjs";
import { composition, protectedSupervisorFor, TEST_resetProtectedComposition, ENROLLMENT_SCHEMA } from "../../control/windows/node/protected-supervisor.mjs";
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

async function world(t) {
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
  const state = { loseStageReply: false, dropStageBeforeSend: false, hangHold: false, accepted: null };
  composition.hostId = HOST;
  composition.store = ownedObligationStore(olog);
  composition.collect = async (rec) => envelope(rec);
  // TEST transport interpositions (labelled): lost stage reply after processing, stage dropped before sending, hung boundary hold
  composition.controlFor = (p) => { const real = new GuestdControl(p.manager, parseKey(fs.readFileSync(p.controlKeyFile, "utf8")));
    return { request: async (m, u, ...rest) => {
      if (state.dropStageBeforeSend && m === "POST" && u === "/protected/vms") { olog.release(); throw Object.assign(Error("TEST stage dropped before reaching the manager after owner release"), { mayHaveExecuted: true }); }
      if (state.hangHold && m === "POST" && /\/hold$/.test(u)) return new Promise(() => {});
      const out = await real.request(m, u, ...rest);
      if (state.loseStageReply && m === "POST" && u === "/protected/vms") {
        assert.equal(out.status, 202); state.accepted = out.body.instanceId; olog.release(); throw Object.assign(Error("TEST processed stage reply lost after owner release"), { mayHaveExecuted: true });
      }
      return out;
    } }; };
  composition.openRuntime = async ({ host, bind }) => {
    const a = bind({ gate, pins: PINS });
    runtime = createIsolationLifecycleRuntime({ client: a.client, gate, journal: lj, plans: a.plans, readiness: a.readiness, collectPermit: a.collectPermit, boundaries: a.boundaries, host });
    return { runtime, gate, pins: PINS, handoff: { owns: () => true, activated: () => true, why: () => null, activate: async () => [], newWorkRefusal: () => null, label: "TEST fixture (r9): route handoff pre-activated; the real dispatch handoff is r9-real-owned-factory" }, snapshot: async (id) => { const ctx = await authority.read(id);
      return { ...ctx, id, blockAt: ctx.assignment.observedAt * 1000, blockHash: ctx.assignment.blockHash, authorityTier: ctx.assignment.authorityTier, admitted: ctx.hostAdmitted, funded: ctx.assignment.funded, verified: ctx.assignment.proofVerified, assignment: { ...ctx.assignment, revision: 1 }, hostAuthorityEvidence: ctx.hostAuthority, profile: PINS.profile }; } };
  };
  process.env.ENCLAVE_PROTECTED_ENROLLMENT = polFile;
  process.env.ENCLAVE_PROTECTED_ENROLLMENT_SHA256 = createHash("sha256").update(pol).digest("hex");
  t.after(() => { delete process.env.ENCLAVE_PROTECTED_ENROLLMENT; delete process.env.ENCLAVE_PROTECTED_ENROLLMENT_SHA256; TEST_resetProtectedComposition(); });
  const body = { derive: record, name: DEPLOYMENT, isPublic: true, hasSecrets: false };
  return { manager, enforcement, authority, legacyClient: new IsolationManagerClient({ base }), inventory, body, gate, state, ofile,
    coldControl: () => new GuestdControl(base, controlKey), runtime: () => runtime };
}
const live = (w) => readInv(w.inventory).vms;   // the exclusive TEST world's full inventory (root correction)
const step = (w) => reconcile({ client: w.legacyClient, deployment: { id: DEPLOYMENT, body: w.body } });
const notRemoved = (w) => w.enforcement.journal.instances().filter((r) => r.deployment === DEPLOYMENT && r.state !== "removed");

test("ROOT supervisor owns unknown processed stage through owner loss and reconciles exact removal", async (t) => {
  const w = await world(t); w.state.loseStageReply = true;
  try {
    await step(w); assert.ok(w.state.accepted, "real manager accepted exactly one stage");
    const sup = await protectedSupervisorFor(w.legacyClient);
    assert.ok(sup.client.ownerLost); assert.equal(sup.client.unknownStages.size, 1, "raw op retained");
    await step(w); await new Promise((r) => setTimeout(r, 500));
    assert.equal(w.enforcement.journal.instance(w.state.accepted).state, "removed", "owner-loss reconcile must retire unknown accepted raw operation, not report zero pending stages");
    assert.equal(live(w).length, 0);
    // r8 strengthening: honest accounting, then cold-owner discharge from the manager's authenticated outcome
    const o = sup.client.outstanding();
    assert.equal(o.retiring.length, 0); assert.equal(o.unresolved.length, 0);
    assert.deepEqual(o.durableUndischarged, [DEPLOYMENT], "the durable pre-send record is NOT discharged by a handle that is no longer the owner");
    assert.match((await step(w)).reason, /1 durable pre-send record\(s\) await a cold owner/);
    const cold = openOwnedLog(w.ofile, { purpose: OBLIGATION_PURPOSE, exclusion: TEST_inProcessExclusion() }); t.after(() => { try { cold.release(); } catch {} });
    const cc = new ProtectedIsolationClient({ control: w.coldControl(), store: ownedObligationStore(cold) });
    assert.equal(cc.unknownStages.get(DEPLOYMENT)?.operation, sup.client.unknownStages.get(DEPLOYMENT).operation, "cold owner replays the exact pre-send operation");
    const r = await cc.resolveUnknown();
    assert.match(r[0].discharged ?? "", new RegExp(`executed instance ${w.state.accepted} confirmed terminal and absent`));
    assert.equal(cc.unknownStages.size, 0); assert.equal(ownedObligationStore(cold).load().unknown[DEPLOYMENT], undefined, "durably discharged by the cold owner");
  } finally { if (w.state.accepted) await w.enforcement.withdraw(w.state.accepted, "TEST exact cleanup").catch(() => {}); }
});

test("r8 supervisor cancels an UNSEEN raw stage after owner loss; the late original is refused", async (t) => {
  const w = await world(t); w.state.dropStageBeforeSend = true;
  await step(w);
  const sup = await protectedSupervisorFor(w.legacyClient);
  assert.ok(sup.client.ownerLost); const op = sup.client.unknownStages.get(DEPLOYMENT)?.operation; assert.match(String(op), /^op[0-9a-f]{32}$/);
  w.state.dropStageBeforeSend = false;
  const r = await step(w);
  assert.match(r.reason, /0 unknown raw operation\(s\) without terminal proof/);
  assert.equal(sup.client.ownerLossProofs.get(DEPLOYMENT)?.outcome, "cancelled before execution");
  assert.deepEqual(sup.client.outstanding().durableUndischarged, [DEPLOYMENT]);
  const late = await w.coldControl().request("POST", "/protected/vms", { schema: STAGE_SCHEMA, deployment: DEPLOYMENT, stagingMs: 30_000, spawn: { ...w.body, name: DEPLOYMENT }, operation: op }, { idempotent: false });
  assert.notEqual(late.status, 202, "a cancelled operation never executes later");
  assert.equal(notRemoved(w).length, 0); assert.equal(live(w).length, 0);
});

test("r8 hung boundary hold during owner-loss retirement does not delay exact compute removal", async (t) => {
  const w = await world(t); w.state.loseStageReply = true;
  try {
    await step(w); assert.ok(w.state.accepted);
    w.state.hangHold = true;
    const r = await step(w);
    assert.equal(w.enforcement.journal.instance(w.state.accepted).state, "removed", r.reason);
    assert.equal(live(w).length, 0);
  } finally { if (w.state.accepted) await w.enforcement.withdraw(w.state.accepted, "TEST exact cleanup").catch(() => {}); }
});

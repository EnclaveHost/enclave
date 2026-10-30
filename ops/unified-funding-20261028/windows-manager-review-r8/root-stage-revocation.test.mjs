// permit r5 (AUTHORED, NOT RUN). Positive and negative tests for the r5 ownership/authentication repairs, through the
// ACTUAL chain: isolation-lifecycle.reconcile/retire (what host.mjs #isolationReconcile/#retireIsolated call) ->
// protectedSupervisorFor (pinned TEST enrollment, actual host id bound) -> r18 createIsolationLifecycleRuntime (mapped
// into the candidate by RELEASE-CLOSURE-R5.json, NOT an absolute external import) -> ProtectedIsolationClient ->
// GuestdControl (real handshake/MAC over TCP) -> createProtectedServer/ControlServer -> PermitEnforcement built by
// compose.mjs composeProtected (the function main.mjs calls) -> real guard process, real data-plane splice.
// TEST and labelled: JSON "Hyper-V" inventory, launcher/readiness doubles, TEST authority snapshot and witnesses, TEST
// in-memory r18 lifecycle journal, in-process journal exclusion, TEST held transport. Not Windows/Hyper-V/Base evidence.
// Must FAIL if: hold becomes destructive for the owned staged instance (restage churn), the client discharges an unknown
// stage on elapsed time, a terminal row masks an unmapped pp VM, unsigned DELETE reaches withdrawal, or a changed client
// origin downgrades an enrolled deployment to legacy.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createHash } from "node:crypto";
import net from "node:net";
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
import { createIsolationLifecycleRuntime } from "./candidate/control/network/deployment-isolation-runtime.mjs";   // RELEASE-CLOSURE-R5 mapping
import { GuestdControl, GuestdControlError } from "./candidate/control/isolation/m4/guestd/control-client.mjs";
import { IsolationManagerClient } from "./candidate/control/windows/node/isolation-client.mjs";
import { reconcile, retire } from "./candidate/control/windows/node/isolation-lifecycle.mjs";
import { ProtectedIsolationClient, fileObligationStore } from "./candidate/control/windows/node/protected-isolation.mjs";
import { composition, TEST_resetProtectedComposition, ENROLLMENT_SCHEMA } from "./candidate/control/windows/node/protected-supervisor.mjs";
import { PINS, HOST, DEPLOYMENT, KEY, vectors, tmp, writeInv, readInv, testLauncher, echoServer, startGuard, selfIdentity, testAuthority, envelope, waitFor } from "./candidate/test/windows-permit/helpers/world.mjs";

/** TEST in-memory lifecycle journal with exactly the methods the r18 runtime calls. NOT the owned r18 journal. */
function TEST_lifecycleJournal() {
  const rows = new Map(); const row = (id) => rows.get(id) ?? { sequence: 0, runtime: null, attempts: 0 };
  return { label: "TEST-in-memory-lifecycle-journal", read: (id) => ({ ...row(id) }),
    rememberRuntime(id, { instance, generation, now }) { const r = row(id); const prev = r.runtime?.instance === instance ? r.runtime : null;
      r.runtime = { instance, generation, startedAt: prev?.startedAt ?? now }; rows.set(id, r); return r.runtime; },
    retireRuntime(id, instance) { const r = row(id); if (r.runtime?.instance === instance) r.runtime = null; rows.set(id, r); },
    beginAttempt(id) { const r = row(id); r.attempts++; rows.set(id, r); return r.attempts; },
    bumpSequence(id) { const r = row(id); r.sequence++; rows.set(id, r); } };
}

async function world(t, { hostId = HOST } = {}) {
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
  const controlKey = crypto.randomBytes(32), removed = [];
  const computeRemover = { label: "TEST-independent-remover", async survey() { return readInv(inventory); },
    async removeById(vmId) { const j = readInv(inventory), n = j.vms.length; j.vms = j.vms.filter((v) => v.vmId !== vmId); writeInv(inventory, j); removed.push(vmId); return n === j.vms.length ? { found: false, removed: false } : { found: true, removed: true }; } };
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
  const lj = TEST_lifecycleJournal(), collected = [];
  composition.hostId = hostId;                                                   // the node's verified identity (TEST value)
  composition.store = fileObligationStore(path.join(dir, "obligations.json"));   // durable obligations (TEST dir)
  composition.collect = async (rec) => { const e = await envelope(rec); collected.push(e); return e; };   // owner-selected TEST witnesses
  composition.openRuntime = async ({ host, bind }) => {
    const a = bind({ gate, pins: PINS });
    const runtime = createIsolationLifecycleRuntime({ client: a.client, gate, journal: lj, plans: a.plans, readiness: a.readiness, collectPermit: a.collectPermit, boundaries: a.boundaries, host });
    return { runtime, gate, pins: PINS, snapshot: async (id) => { const ctx = await authority.read(id);
      return { ...ctx, id, blockAt: ctx.assignment.observedAt * 1000, blockHash: ctx.assignment.blockHash, authorityTier: ctx.assignment.authorityTier, admitted: ctx.hostAdmitted, funded: ctx.assignment.funded, verified: ctx.assignment.proofVerified, assignment: { ...ctx.assignment, revision: 1 }, hostAuthorityEvidence: ctx.hostAuthority, profile: PINS.profile }; } };
  };
  process.env.ENCLAVE_PROTECTED_ENROLLMENT = polFile;
  process.env.ENCLAVE_PROTECTED_ENROLLMENT_SHA256 = createHash("sha256").update(pol).digest("hex");
  t.after(() => { delete process.env.ENCLAVE_PROTECTED_ENROLLMENT; delete process.env.ENCLAVE_PROTECTED_ENROLLMENT_SHA256; TEST_resetProtectedComposition(); });
  const body = { derive: record, name: DEPLOYMENT, isPublic: true, hasSecrets: false };
  return { manager, enforcement, dp, authority, legacyClient: new IsolationManagerClient({ base }), inventory, body, base, removed, collected, gate, controlKey, dir };
}

const splice = (dp, m) => new Promise((resolve) => {
  const c = net.connect(dp.server.address().port, "127.0.0.1"); let got = ""; c.on("error", () => {}); c.setEncoding("latin1"); c.on("data", (d) => { got += d; });
  c.on("connect", () => c.write(`ENCLAVE-SPLICE/1 id=${m.id} app=${m.appId} image=${m.image} runtime=${m.runtimeId} key=${KEY}\n`));
  setTimeout(() => resolve({ c, got: () => got }), 300);
});
const stagedId = (w) => waitFor(() => w.enforcement.journal.instances().find((r) => r.deployment === DEPLOYMENT && r.state === "staged")?.instanceId);

test("ROOT explicit authority revocation withdraws an owned ready staged instance promptly", async (t) => {
  const w = await world(t); let runtime;
  const open = composition.openRuntime;
  composition.openRuntime = async (...args) => { const owned = await open(...args); runtime = owned.runtime; return owned; };
  await reconcile({ client: w.legacyClient, deployment: { id: DEPLOYMENT, body: w.body } });
  const id = await stagedId(w);
  try {
    await waitFor(() => w.manager.get(id)?.status === "running");
    const ready = await reconcile({ client: w.legacyClient, deployment: { id: DEPLOYMENT, body: w.body } });
    assert.match(ready.reason, /readiness-verified/);
    w.authority.s.online = false; w.authority.s.admitted = false;
    await runtime.revokeHostAuthority(DEPLOYMENT, { hostAuthorityEvidence: (await w.authority.read(DEPLOYMENT)).hostAuthority });
    await new Promise(r => setTimeout(r, 750));
    assert.equal(w.enforcement.journal.instance(id).state, "removed", "explicit authority withdrawal must retire staged compute, without waiting for its 30-second staging deadline");
    assert.equal(readInv(w.inventory).vms.some(v => v.notes?.includes(id)), false);
  } finally { await w.enforcement.withdraw(id, "TEST cleanup"); }
});

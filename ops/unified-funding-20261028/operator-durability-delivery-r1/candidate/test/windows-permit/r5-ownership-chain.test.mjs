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
import { createIsolationLifecycleRuntime } from "../../control/network/deployment-isolation-runtime.mjs";   // RELEASE-CLOSURE-R5 mapping
import { GuestdControl, GuestdControlError } from "../../control/isolation/m4/guestd/control-client.mjs";
import { IsolationManagerClient } from "../../control/windows/node/isolation-client.mjs";
import { reconcile, retire } from "../../control/windows/node/isolation-lifecycle.mjs";
import { ProtectedIsolationClient, fileObligationStore } from "../../control/windows/node/protected-isolation.mjs";
import { composition, TEST_resetProtectedComposition, ENROLLMENT_SCHEMA } from "../../control/windows/node/protected-supervisor.mjs";
import { PINS, HOST, DEPLOYMENT, KEY, vectors, tmp, writeInv, readInv, testLauncher, echoServer, startGuard, selfIdentity, testAuthority, envelope, waitFor, basisOf } from "./helpers/world.mjs";

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
    return { runtime, gate, pins: PINS, handoff: { owns: () => true, activated: () => true, why: () => null, activate: async () => [], newWorkRefusal: () => null, label: "TEST fixture (r9): route handoff pre-activated; the real dispatch handoff is r9-real-owned-factory" }, snapshot: async (id) => { const ctx = await authority.read(id);
      // r10: carried root r9 snapshot correction (id/block/tier/admission/funding/verified from the TEST authority's assignment context)
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

test("R5 DIRECT: repeated queued reconcile keeps the SAME staged instance through readiness, then Running permit, I/O, Stop", async (t) => {
  const w = await world(t);
  const r1 = await reconcile({ client: w.legacyClient, deployment: { id: DEPLOYMENT, body: w.body, basis: await basisOf(w.authority, DEPLOYMENT) } });
  assert.equal(r1.action, "held"); assert.match(r1.reason, /^protected:/);
  const id = await stagedId(w);
  await waitFor(() => w.manager.get(id)?.status === "running");
  // root-supervisor-diagnostic: the second (and third) queued pass used to REMOVE the stage and start a new pp instance
  for (let i = 0; i < 3; i++) {
    const r = await reconcile({ client: w.legacyClient, deployment: { id: DEPLOYMENT, body: w.body, basis: await basisOf(w.authority, DEPLOYMENT) } });
    assert.match(r.reason, /readiness-verified/, `pass ${i + 2}: ${r.reason}`);
    assert.equal(r.instance?.id, id, "the same owned staged instance");
  }
  assert.deepEqual(w.enforcement.journal.instances().filter((r) => r.deployment === DEPLOYMENT).map((r) => [r.instanceId, r.state]), [[id, "staged"]],
    "exactly one protected record, still staged (no hold, no removal, no second stage)");
  assert.equal(w.removed.length, 0, "the independent remover was never asked");
  const wall = w.enforcement.journal.instance(id).stagingWallUntil;
  // Running: exactly the collected envelope reaches the manager's gate; usable I/O
  w.authority.s.state = "running"; w.authority.s.generation = w.enforcement.journal.instance(id).generation;
  const r3 = await reconcile({ client: w.legacyClient, deployment: { id: DEPLOYMENT, body: w.body, basis: await basisOf(w.authority, DEPLOYMENT) } });
  assert.equal(r3.action, "adopted", r3.reason); assert.equal(r3.instance.id, id); assert.equal(r3.instance.protected.serving, true);
  assert.equal(r3.instance.protected.hostAuthority, w.gate.entries.get(DEPLOYMENT).hostAuthority ?? r3.instance.protected.hostAuthority);
  assert.equal(w.enforcement.journal.instance(id).permit.digest, w.gate.entries.get(DEPLOYMENT).digest);
  assert.equal(w.enforcement.journal.instance(id).stagingWallUntil, wall, "the staging deadline was never extended by a retry");
  const s = await splice(w.dp, w.manager.get(id)); assert.match(s.got(), /^OK/, "usable I/O under the permit");
  // owner Stop through retire: stream closed, exact compute confirmed gone, durable removed
  const gone = await retire({ client: w.legacyClient, deployment: { id: DEPLOYMENT } });
  assert.equal(gone.removed, true, gone.reason);
  await waitFor(() => s.c.destroyed || s.c.readableEnded);
  assert.equal(readInv(w.inventory).vms.some((v) => v.notes?.includes(id)), false);
  assert.equal(w.enforcement.journal.instance(id).state, "removed");
});

test("R5 changed client origin: an enrolled deployment never reaches legacy lookup; it reaches the policy's protected owner", async (t) => {
  const w = await world(t); let calls = 0;
  const other = { base: "http://127.0.0.1:9", findByName: async () => { calls++; throw Error("TEST legacy lookup"); }, spawn: async () => { calls++; throw Error("TEST legacy spawn"); } };
  const r = await reconcile({ client: other, deployment: { id: DEPLOYMENT, body: w.body, basis: await basisOf(w.authority, DEPLOYMENT) }, deadlineMs: 1 });
  assert.equal(calls, 0); assert.match(r.reason, /^protected:/);
  await stagedId(w);   // staged on the POLICY's manager, not the caller's origin
});

test("R5 host identity mismatch holds enrolled deployments; unenrolled neighbours stay legacy", async (t) => {
  const w = await world(t, { hostId: "0x" + "ab".repeat(32) });
  const r = await reconcile({ client: w.legacyClient, deployment: { id: DEPLOYMENT, body: w.body, basis: await basisOf(w.authority, DEPLOYMENT) } });
  assert.equal(r.action, "held"); assert.match(r.reason, /host identity/);
  assert.equal(w.enforcement.journal.instances().length, 0);
  const other = "0x" + "77".repeat(32);
  const n = await reconcile({ client: w.legacyClient, deployment: { id: other, body: { ...w.body, name: other } }, deadlineMs: 50, pollMs: 10 });
  assert.notEqual(String(n.reason ?? "").startsWith("protected:"), true);
});

test("R5 lost stage (actual MAC/TCP, TEST held transport): owned until the exact outcome; cancel refuses the late signed request", async (t) => {
  const w = await world(t);
  const ctl = new GuestdControl(w.base, w.controlKey), orig = ctl._fetch.bind(ctl); let held = null;
  ctl._fetch = async (url, init) => {
    if (new URL(url).pathname === "/protected/vms" && !held) { held = { url, init }; throw new GuestdControlError("transport", "TEST request held before server"); }
    return orig(url, init);
  };
  const client = new ProtectedIsolationClient({ control: ctl, store: fileObligationStore(path.join(w.dir, "lost.json")) });
  await assert.rejects(client.stage({ deployment: DEPLOYMENT, stagingMs: 30_000, spawn: w.body }));
  assert.ok(held); assert.equal(client.unknownStages.has(DEPLOYMENT), true);
  // a fresh client from the same durable store still owns it (restart)
  const again = new ProtectedIsolationClient({ control: ctl, store: fileObligationStore(path.join(w.dir, "lost.json")) });
  assert.equal(again.unknownStages.get(DEPLOYMENT).operation, client.unknownStages.get(DEPLOYMENT).operation);
  const out = await again.resolveUnknown();
  assert.match(JSON.stringify(out), /cancelled before execution/);
  assert.equal(again.unknownStages.has(DEPLOYMENT), false, "discharged only by the durable cancellation acknowledgment");
  const late = await fetch(held.url, held.init);   // the exact original signed request arrives late
  assert.equal(late.status, 409, "the cancelled operation is refused, never executed");
  assert.equal(w.enforcement.journal.instances().some((r) => r.deployment === DEPLOYMENT), false, "nothing staged");
});

test("R5 inventory: a terminal row never masks an unmapped live protected VM", async (t) => {
  const w = await world(t);
  await reconcile({ client: w.legacyClient, deployment: { id: DEPLOYMENT, body: w.body, basis: await basisOf(w.authority, DEPLOYMENT) } });
  const id = await stagedId(w);
  await w.enforcement.withdraw(id, "TEST make a terminal row");
  await waitFor(() => w.enforcement.journal.instance(id).state === "removed");
  const ghost = "pp" + "ee".repeat(16);
  w.manager.domains.set(ghost, { id: ghost, name: DEPLOYMENT, status: "running" });   // TEST: an unmapped pp domain
  t.after(() => w.manager.domains.delete(ghost));
  const client = new ProtectedIsolationClient({ control: new GuestdControl(w.base, w.controlKey) });
  await assert.rejects(client.inventory(DEPLOYMENT), /unknown/);
});

test("R5 unsigned protected mutation aliases are refused without disturbing state; legacy routes unchanged", async (t) => {
  const w = await world(t);
  await reconcile({ client: w.legacyClient, deployment: { id: DEPLOYMENT, body: w.body, basis: await basisOf(w.authority, DEPLOYMENT) } });
  const id = await stagedId(w);
  for (const p of [`/vms/${id}`, `/vms/${id.toUpperCase()}`, `/vms/${id}/`, `/vms/%70%70${id.slice(2)}`, `/vms/${id}?x=1`])
    assert.equal((await fetch(w.base + p, { method: "DELETE" })).status, 401, p);
  assert.equal(w.enforcement.journal.instance(id).state, "staged", "no withdrawal from an unsigned request");
  assert.notEqual((await fetch(`${w.base}/vms/legacy-not-there`, { method: "DELETE" })).status, 401, "legacy route still reaches the installed handler");
  // the authenticated owner Stop still works
  const r = await new GuestdControl(w.base, w.controlKey).request("DELETE", `/vms/${id}`, undefined, { idempotent: true });
  assert.equal(r.status, 200);
  assert.equal(w.enforcement.journal.instance(id).state, "removed");
});

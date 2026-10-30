// permit r8 (AUTHORED, NOT RUN). Carried ROOT r7 regression root-permit-owner-release.test.mjs (evidence/root-r7, 2 FAIL there) with
// portable relative imports, UNWEAKENED (the original assert.rejects is kept verbatim), and strengthened:
//   - the ACTUAL ProtectedIsolationClient over the real MAC'd GuestdControl/ControlServer/PermitEnforcement (rig);
//   - the physical obligation owner (node-owned.log) is released AFTER the manager processed the permit (200) and BEFORE the reply is
//     delivered (delivered) or while it is lost and reconciled from the MAC'd view (lost+reconciled) - not a before-send release;
//   - the manager's serving-permit owner (w.log, the enforcement's permit journal) is a DISTINCT handle that stays live: the client
//     must withdraw on ITS owner loss alone;
//   - cleanup through the actual client: exact instance removed in the manager journal and TEST inventory, no splice allowed afterwards,
//     no new stage/permit;
//   - positive controls (owner kept): delivered and lost+reconciled permits still return serving (lost-permit recovery preserved).
// TEST and labelled: JSON inventory/launcher/readiness doubles, TEST authority + witnesses, in-process log exclusion.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rig, DEPLOYMENT, permitRecord, envelope, waitFor } from "./candidate/test/windows-permit/helpers/world.mjs";
import { initializeOwnedLog, openOwnedLog, TEST_inProcessExclusion } from "./candidate/control/windows/vbslike/manager/win-durable.mjs";
import { ProtectedIsolationClient, ownedObligationStore, OBLIGATION_PURPOSE } from "./candidate/control/windows/node/protected-isolation.mjs";

for (const lostResponse of [false, true]) test(`ROOT physical owner released during processed permit response (${lostResponse ? "lost+reconciled" : "delivered"}) cannot return serving`, async (t) => {
  const w = await rig(t); const file = path.join(w.dir, "node-owned.log"); initializeOwnedLog(file, { purpose: OBLIGATION_PURPOSE });
  const log = openOwnedLog(file, { purpose: OBLIGATION_PURPOSE, exclusion: TEST_inProcessExclusion() }); let accepted = null;
  const c = new ProtectedIsolationClient({ store: ownedObligationStore(log), cleanupStepMs: 1000, cleanupRetryMs: 100, control: { request: async (...args) => {
    const r = await w.client.request(...args);
    if (args[0] === "POST" && args[1].endsWith("/permit")) { assert.equal(r.status, 200); log.release(); if (lostResponse) throw Object.assign(Error("TEST processed permit reply lost"), { mayHaveExecuted: true }); }
    return r;
  } } });
  try {
    const b = await c.stage({ deployment: DEPLOYMENT, stagingMs: 30000, spawn: w.spawnBody }); accepted = b.instanceId; await w.staged(accepted);
    w.authority.s.state = "running"; w.authority.s.generation = w.journal.instance(accepted).generation;
    const rec = permitRecord({ generation: w.authority.s.generation, sequence: 1, now: w.now });
    const retainedAttachment = w.attachment(accepted, rec);
    await assert.rejects(c.permit(accepted, await envelope(rec), retainedAttachment, { hostAuthority: rec.hostAuthority.digest }), /owner|released|durab|unknown/i, "an in-flight permit must not restore released ownership");
    // r8 strengthening
    assert.ok(c.ownerLost, "the loss is latched by the client");
    assert.equal(w.log.released(), false, "the manager's serving-permit owner is a distinct handle and is still live: the node withdrew on its own owner loss");
    assert.equal(c.retirements.get(DEPLOYMENT)?.instanceId, accepted, "the exact instance is owned for retirement");
    await waitFor(async () => { await c.reconcileOrphans(); return w.journal.instance(accepted).state === "removed" && w.vms().length === 0; }, 10_000);
    assert.equal(w.manager.get(accepted)?.status ?? "absent", "absent", "no live VM after withdrawal");
    assert.equal(c.outstanding().retiring.length, 0);
    const s = await w.splice(accepted);
    assert.doesNotMatch(s.got(), /^OK/, "no stream is admitted for the withdrawn instance"); s.c.destroy();
    await assert.rejects(c.stage({ deployment: DEPLOYMENT, stagingMs: 30000, spawn: w.spawnBody }), /owner lost/i, "no new stage after owner loss");
    const rec2 = permitRecord({ generation: w.authority.s.generation, sequence: 2, now: w.now });
    await assert.rejects(c.permit(accepted, await envelope(rec2), retainedAttachment, { hostAuthority: rec2.hostAuthority.digest }), /owner lost/i, "no new serving after owner loss");
  } finally { if (accepted) await w.enforcement.withdraw(accepted, "TEST cleanup").catch(() => {}); try { log.release(); } catch {} }
});

for (const lostResponse of [false, true]) test(`r8 positive control: owner kept, ${lostResponse ? "lost permit reply reconciled from the MAC'd view" : "delivered permit"} returns serving`, async (t) => {
  const w = await rig(t); const file = path.join(w.dir, "node-owned.log"); initializeOwnedLog(file, { purpose: OBLIGATION_PURPOSE });
  const log = openOwnedLog(file, { purpose: OBLIGATION_PURPOSE, exclusion: TEST_inProcessExclusion() }); let accepted = null;
  const c = new ProtectedIsolationClient({ store: ownedObligationStore(log), control: { request: async (...args) => {
    const r = await w.client.request(...args);
    if (lostResponse && args[0] === "POST" && args[1].endsWith("/permit")) { assert.equal(r.status, 200); throw Object.assign(Error("TEST processed permit reply lost"), { mayHaveExecuted: true }); }
    return r;
  } } });
  try {
    const b = await c.stage({ deployment: DEPLOYMENT, stagingMs: 30000, spawn: w.spawnBody }); accepted = b.instanceId; await w.staged(accepted);
    w.authority.s.state = "running"; w.authority.s.generation = w.journal.instance(accepted).generation;
    const rec = permitRecord({ generation: w.authority.s.generation, sequence: 1, now: w.now });
    const att = w.attachment(accepted, rec);
    const out = await c.permit(accepted, await envelope(rec), att, { hostAuthority: rec.hostAuthority.digest });
    assert.equal(out.serving, true); assert.equal(out.permitDigest, att.permitDigest); assert.equal(out.instanceId, accepted);
    assert.equal(out.reconciled === true, lostResponse);
    assert.ok(out.validUntil <= att.validUntil, "never an extended deadline");
    assert.equal(c.ownerLost, null); assert.equal(c.retirements.size, 0);
    assert.equal(w.journal.instance(accepted).state, "serving");
  } finally { if (accepted) await w.enforcement.withdraw(accepted, "TEST cleanup").catch(() => {}); try { log.release(); } catch {} }
});

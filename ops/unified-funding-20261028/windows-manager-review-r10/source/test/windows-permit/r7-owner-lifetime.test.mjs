// permit r7 (AUTHORED, NOT RUN). Physical obligation-owner lifetime through the ACTUAL client over ACTUAL MAC/HTTP: rig() (ProtectedManager,
// PermitEnforcement, ControlServer, createProtectedServer, real guard process) <- GuestdControl <- ProtectedIsolationClient over
// ownedObligationStore(openOwnedLog(...)). Extends ROOT evidence/root-r6/root-owner-release.test.mjs (0/1) through retirement and cold
// recovery. TEST and labelled: JSON "Hyper-V" inventory, launcher/readiness doubles, TEST_inProcessExclusion (logic evidence only, NOT a
// Windows share-mode/EXLOCK qualification), a TEST fs wrapper that fails writes on demand, and the request interposition that releases
// the owner at an exact point of the actual exchange.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { rig, DEPLOYMENT, waitFor } from "./helpers/world.mjs";
import { initializeOwnedLog, openOwnedLog, TEST_inProcessExclusion } from "../../control/windows/vbslike/manager/win-durable.mjs";
import { ProtectedIsolationClient, ownedObligationStore, OBLIGATION_PURPOSE } from "../../control/windows/node/protected-isolation.mjs";

function ownedLog(w, name = "node-owned.log", fsImpl = fs) {
  const file = path.join(w.dir, name);
  if (!fs.existsSync(file)) initializeOwnedLog(file, { purpose: OBLIGATION_PURPOSE });
  return { file, log: openOwnedLog(file, { purpose: OBLIGATION_PURPOSE, exclusion: TEST_inProcessExclusion(), fsImpl }) };
}
const liveVms = (w) => w.vms().length;   // exclusive TEST world: the full inventory

test("ROOT (extended, root r6 0/1): owner released after the actual accepted stage -> no usable success, exact retirement, cold recovery discharges", async (t) => {
  const w = await rig(t); const { file, log } = ownedLog(w); let accepted = null, posts = 0;
  const c = new ProtectedIsolationClient({ store: ownedObligationStore(log), control: { request: async (...args) => {
    if (args[0] === "POST" && args[1] === "/protected/vms") posts++;
    const r = await w.client.request(...args);
    if (args[0] === "POST" && args[1] === "/protected/vms") { assert.equal(r.status, 202); accepted = r.body.instanceId; log.release(); }
    return r; } } });
  try {
    await assert.rejects(c.stage({ deployment: DEPLOYMENT, stagingMs: 30000, spawn: w.spawnBody }), /obligation owner lost after the manager accepted/,
      "a successful response cannot reestablish released ownership");
    assert.ok(accepted);
    assert.ok(c.ownerLost, "the physical owner loss is latched");
    assert.equal(c.staged.has(DEPLOYMENT), false, "no binding is usable");
    assert.equal(c.unknownStages.get(DEPLOYMENT).instanceId, accepted, "the raw accepted operation stays owned in memory");
    // r10: carried root correction (root-corrected-r7-owner-lifetime line36): the map entry is { promise, ... }; identity/absence kept exact
    const retired = await c.retirements.get(DEPLOYMENT).promise;
    assert.deepEqual({ deployment: retired.deployment, operation: retired.operation, instanceId: retired.instanceId, absent: retired.absent }, { deployment: DEPLOYMENT, operation: c.unknownStages.get(DEPLOYMENT).operation, instanceId: accepted, absent: true });
    assert.equal(w.journal.instance(accepted).state, "removed");
    assert.equal(liveVms(w), 0, "no orphaned VM");
    await assert.rejects(c.stage({ deployment: "0x" + "77".repeat(32), stagingMs: 30000, spawn: { ...w.spawnBody, name: "0x" + "77".repeat(32) } }), /obligation owner lost/);
    assert.equal(posts, 1, "nothing is sent after the latch");
    assert.throws(() => ownedObligationStore(log).load(), /released/, "a released descriptor never yields cached state");
    // cold recovery: a NEW owner replays the durable pre-send record and resolves it only from the manager's exact outcome
    const again = openOwnedLog(file, { purpose: OBLIGATION_PURPOSE, exclusion: TEST_inProcessExclusion() }); t.after(() => { try { again.release(); } catch {} });
    const cold = new ProtectedIsolationClient({ store: ownedObligationStore(again), control: w.client });
    const op = cold.unknownStages.get(DEPLOYMENT)?.operation;
    assert.match(String(op), /^op[0-9a-f]{32}$/, "the durable pre-send obligation survived the owner loss");
    const out = await cold.resolveUnknown();
    assert.match(out[0].discharged, new RegExp(`executed instance ${accepted} confirmed terminal and absent`));
    assert.equal(cold.unknownStages.size, 0);
    assert.deepEqual(ownedObligationStore(again).load().unknown, {}, "the discharge is durable");
  } finally { if (accepted) await w.enforcement.withdraw(accepted, "TEST cleanup").catch(() => {}); try { log.release(); } catch {} }
});

test("r7 owner lost WHILE the raw stage is pending: the late 202 never recreates owner authority", async (t) => {
  const w = await rig(t); const { log } = ownedLog(w); let accepted = null;
  const c = new ProtectedIsolationClient({ store: ownedObligationStore(log), control: { request: async (...args) => {
    if (args[0] === "POST" && args[1] === "/protected/vms") { log.release(); const r = await w.client.request(...args); accepted = r.body?.instanceId ?? null; return r; }
    return w.client.request(...args); } } });
  try {
    await assert.rejects(c.stage({ deployment: DEPLOYMENT, stagingMs: 30000, spawn: w.spawnBody }), /obligation owner lost after the manager accepted/);
    assert.ok(accepted, "the manager did accept the raw stage (late 202)");
    await c.retirements.get(DEPLOYMENT).promise;   // r9: carried root correction (entry is { promise, ... })
    assert.equal(w.journal.instance(accepted).state, "removed");
    assert.equal(liveVms(w), 0);
  } finally { if (accepted) await w.enforcement.withdraw(accepted, "TEST cleanup").catch(() => {}); }
});

test("r7 a FAILED owned write after stage latches: no permit is sent, the loss is reported, retirement of the bound instance is the gate's", async (t) => {
  const w = await rig(t); let failWrites = false, permits = 0;
  const testFs = { ...fs, writeSync: (...a) => { if (failWrites) throw Object.assign(Error("TEST EIO"), { code: "EIO" }); return fs.writeSync(...a); } };
  const { log } = ownedLog(w, "node-failing.log", testFs);
  let lost = null;
  const c = new ProtectedIsolationClient({ store: ownedObligationStore(log), onOwnerLost: (e) => { lost = e; }, control: { request: async (...args) => {
    if (args[0] === "POST" && /\/permit$/.test(args[1])) permits++;
    return w.client.request(...args); } } });
  const b = await c.stage({ deployment: DEPLOYMENT, stagingMs: 30000, spawn: w.spawnBody });
  try {
    await w.staged(b.instanceId);
    failWrites = true;
    // the next durable write fails -> latched. TEST trigger: an owned unseen operation of another deployment, whose authenticated
    // cancellation discharge is the client's next actual #save
    c.unknownStages.set("0x" + "78".repeat(32), { operation: "op" + "0".repeat(32), reason: "TEST" });
    const out = await c.resolveUnknown();           // its #save after the cancel outcome fails: latched, never reported durable
    assert.equal(out.some((o) => o.discharged), false, "a discharge that could not be written is never reported");
    assert.ok(c.unknownStages.has("0x" + "78".repeat(32)), "the operation is not forgotten in memory either");
    assert.ok(c.ownerLost && lost, "a failed owned write latches the physical owner loss and is reported");
    assert.match(String(log.failed()), /append\/flush failed/);
    await assert.rejects(c.permit(b.instanceId, { record: {} }, { permitDigest: "0x" + "00".repeat(32) }), /obligation owner lost/);
    assert.equal(permits, 0, "no permit request leaves after the latch");
    assert.throws(() => ownedObligationStore(log).load(), /failed/, "a failed log never yields cached state");
  } finally { await w.enforcement.withdraw(b.instanceId, "TEST cleanup").catch(() => {}); }
});

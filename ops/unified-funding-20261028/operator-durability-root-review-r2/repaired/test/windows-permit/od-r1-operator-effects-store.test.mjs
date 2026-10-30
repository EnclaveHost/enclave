// durability r1 (AUTHORED, NOT RUN). The owned operator-effects store itself, on BOTH backends, with real files in private temp dirs.
//   - "linux-owned-state": genuine /usr/bin/flock owner (in-process second owner AND a separate child process are refused).
//   - "windows-owned-log": the win-durable log LOGIC under TEST_inProcessExclusion (a shared in-process TEST exclusion object, labelled;
//     NOT Windows EXLOCK, NOT cross-process, NOT power-loss qualification - those remain root Windows acceptance items).
// Storage failures are injected through an external TEST fs wrapper passed as fsImpl (the primitives' own injection point), never by
// patching the functions under test. TEST account/chain only; nothing signs, broadcasts or pays.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { initializeOperatorEffects, openOperatorEffects, canonicalBounded, MAX_RECORDS, OPERATOR_EFFECTS_PURPOSE } from "../../control/windows/node/operator-effects.mjs";
import { openOwnedLog, TEST_inProcessExclusion } from "../../control/windows/vbslike/manager/win-durable.mjs";

const ACCOUNT = "0x" + "11".repeat(20), OTHER = "0x" + "99".repeat(20), domain = { account: ACCOUNT, chainId: 8453 };
const flock = process.platform === "linux" && fs.existsSync("/usr/bin/flock");
const tmp = (t) => { const d = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || os.tmpdir(), "od-r1-store-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const sha = (s) => createHash("sha256").update(s).digest("hex");
const writeRecord = (nonce, extra = {}) => {
  const request = canonicalBounded({ address: "0x" + "44".repeat(20), functionName: "renew", args: ["0x" + "22".repeat(32)] });
  return { type: "write", key: `w:${nonce}`, account: ACCOUNT, chainId: 8453, nonce, address: "0x" + "44".repeat(20), functionName: "renew",
    request, requestSha256: sha(request), state: "sending", hash: null, error: null, at: Date.now(), ...extra };
};
// fsyncAfter: null = never fail; n = let n more fsyncs succeed, then fail every one (EIO)
const TEST_FAIL = { fsyncAfter: null, short: false };
const testFs = { ...fs,
  fsyncSync: (fd) => { if (TEST_FAIL.fsyncAfter !== null && TEST_FAIL.fsyncAfter-- <= 0) throw Object.assign(Error("TEST EIO on fsync"), { code: "EIO" }); return fs.fsyncSync(fd); },
  writeSync: (...a) => (TEST_FAIL.short ? 0 : fs.writeSync(...a)) };
test.afterEach(() => Object.assign(TEST_FAIL, { fsyncAfter: null, short: false }));

// ---- Windows owned-log LOGIC (TEST exclusion, labelled) ---------------------------------------------------------------------------------
const W = (exclusion, extra = {}) => ({ domain, backend: "windows-owned-log", platform: "linux", exclusion, fsImpl: testFs, ...extra });

test("win-log: explicit init, one owner, put/remove survive reopen; status never claims production for the TEST exclusion", async (t) => {
  const file = path.join(tmp(t), "operator-effects.journal"), X = TEST_inProcessExclusion();
  await assert.rejects(openOperatorEffects(file, W(X)), /unavailable|refused/, "absent store is never first use");
  assert.equal(fs.existsSync(file), false, "a normal open creates nothing");
  await initializeOperatorEffects(file, W(X));
  await assert.rejects(initializeOperatorEffects(file, W(X)), "re-initialization of an existing store refuses");
  const s = await openOperatorEffects(file, W(X));
  assert.equal(s.status().production, false); assert.match(s.status().note, /TEST exclusion/);
  await assert.rejects(openOperatorEffects(file, W(X)), (e) => e.code === "OwnedElsewhere", "a second owner is refused");
  s.put("w:3", writeRecord(3)); s.put("w:4", writeRecord(4)); s.remove("w:3", "landed");
  await s.release();
  assert.throws(() => s.records(), /released/);
  const again = await openOperatorEffects(file, W(X));
  assert.deepEqual(again.records().map((r) => r.key), ["w:4"]);
  await again.release();
});

test("win-log: foreign domain, foreign record, torn tail and legacy records all refuse", async (t) => {
  const dir = tmp(t), file = path.join(dir, "operator-effects.journal"), X = TEST_inProcessExclusion();
  await initializeOperatorEffects(file, W(X));
  await assert.rejects(openOperatorEffects(file, W(X, { domain: { account: OTHER, chainId: 8453 } })), /not this operator domain/);
  await assert.rejects(openOperatorEffects(file, W(X, { domain: { account: ACCOUNT, chainId: 1 } })), /not this operator domain/);
  // a well-formed event carrying another account's record (written through the raw owned log): never replayed under this domain
  const raw = openOwnedLog(file, { purpose: OPERATOR_EFFECTS_PURPOSE, exclusion: X, platform: "linux" });
  raw.append("operator-effect", { op: "put", key: "w:9", record: { ...writeRecord(9), account: OTHER }, at: Date.now() });
  raw.release();
  await assert.rejects(openOperatorEffects(file, W(X)), /another operator account/);
  // torn tail on a second store: kept, never truncated, refuses
  const f2 = path.join(dir, "torn.journal");
  await initializeOperatorEffects(f2, W(X));
  fs.appendFileSync(f2, '{"seq":99,"partial');
  const before = fs.readFileSync(f2);
  await assert.rejects(openOperatorEffects(f2, W(X)), /torn/);
  assert.deepEqual(fs.readFileSync(f2), before, "the torn bytes are kept exactly");
  // legacy r12 JSON with records blocks initialization
  fs.writeFileSync(path.join(dir, "operator-writes.json"), JSON.stringify({ schema: "enclave-operator-writes/1", records: { x: {} } }));
  await assert.rejects(initializeOperatorEffects(path.join(dir, "new.journal"), W(X, { legacy: [path.join(dir, "operator-writes.json")] })), (e) => e.code === "LegacyObligations");
  assert.equal(fs.existsSync(path.join(dir, "new.journal")), false);
});

test("win-log: a short write latches the store (outcome unknown); every later read/change refuses", async (t) => {
  const file = path.join(tmp(t), "operator-effects.journal"), X = TEST_inProcessExclusion();
  await initializeOperatorEffects(file, W(X));
  const s = await openOperatorEffects(file, W(X));
  TEST_FAIL.short = true;
  assert.throws(() => s.put("w:1", writeRecord(1)), (e) => e.code === "OperatorEffectsUncertain" && e.uncertain === true);
  TEST_FAIL.short = false;
  assert.throws(() => s.records(), /failed/); assert.throws(() => s.put("w:2", writeRecord(2)), /failed/);
  await s.release();
});

test("win-log: bounded - a full store refuses NEW records, settlement stays possible; an oversized request is refused, never truncated", async (t) => {
  const file = path.join(tmp(t), "operator-effects.journal"), X = TEST_inProcessExclusion();
  await initializeOperatorEffects(file, W(X));
  const s = await openOperatorEffects(file, W(X));
  for (let n = 0; n < MAX_RECORDS; n++) s.put(`w:${n}`, writeRecord(n));
  assert.throws(() => s.put(`w:${MAX_RECORDS}`, writeRecord(MAX_RECORDS)), (e) => e.code === "StoreFull");
  assert.equal(s.records().length, MAX_RECORDS, "nothing unresolved was dropped to make room");
  s.remove("w:0", "nonce-consumed (fence)");
  s.put(`w:${MAX_RECORDS}`, writeRecord(MAX_RECORDS));
  assert.throws(() => canonicalBounded({ args: ["x".repeat(20000)] }), (e) => e.code === "RequestNotRecordable");
  await s.release();
});

// ---- Linux owned state (genuine flock) --------------------------------------------------------------------------------------------------
const L = (extra = {}) => ({ domain, fsImpl: testFs, ...extra });
test("linux: genuine flock - a second in-process owner AND a separate process are refused while held; after release the child owns it", { skip: !flock && "needs Linux /usr/bin/flock" }, async (t) => {
  const file = path.join(tmp(t), "operator-effects.journal");
  await initializeOperatorEffects(file, L());
  const s = await openOperatorEffects(file, L());
  assert.equal(s.exclusion, "linux-flock"); assert.equal(s.status().production, true);
  s.put("w:7", writeRecord(7));
  await assert.rejects(openOperatorEffects(file, L()), (e) => e.code === "OwnedElsewhere");
  const child = new URL("./helpers/od-r1-owner-child.mjs", import.meta.url);
  const held = JSON.parse(execFileSync(process.execPath, [child.pathname, file, ACCOUNT, "8453"], { encoding: "utf8" }).trim());
  assert.equal(held.ok, false, "another process cannot load, overwrite or settle this owner's work"); assert.equal(held.code, "OwnedElsewhere");
  await s.release();
  const after = JSON.parse(execFileSync(process.execPath, [child.pathname, file, ACCOUNT, "8453"], { encoding: "utf8" }).trim());
  assert.deepEqual(after, { ok: true, unresolved: 1 }, "the next owner sees the retained record");
});

test("linux: deletion of an established store, a foreign domain and an fsync failure all refuse; never re-created as empty", { skip: !flock && "needs Linux /usr/bin/flock" }, async (t) => {
  const dir = tmp(t), file = path.join(dir, "operator-effects.journal");
  await initializeOperatorEffects(file, L());
  await assert.rejects(initializeOperatorEffects(file, L()), (e) => e.code === "AlreadyEstablished");
  await assert.rejects(openOperatorEffects(file, L({ domain: { account: OTHER, chainId: 8453 } })), /refused/);
  // an fsync failure AFTER the new intent landed (intent temp fsync + its directory sync succeed, the state file's fsync fails): latched;
  // the reopened store is UNCERTAIN (intent without its matching acknowledgement) and refuses until explicit owned recovery
  const s = await openOperatorEffects(file, L());
  TEST_FAIL.fsyncAfter = 2;
  assert.throws(() => s.put("w:1", writeRecord(1)), (e) => e.uncertain === true);
  TEST_FAIL.fsyncAfter = null;
  assert.throws(() => s.records(), /failed/);
  await s.release();
  await assert.rejects(openOperatorEffects(file, L()), /uncertain|refused/);
  // a second store: delete only the state file, then everything: both refuse, nothing is re-created
  const f2 = path.join(dir, "deleted.journal");
  await initializeOperatorEffects(f2, L());
  fs.unlinkSync(f2);
  await assert.rejects(openOperatorEffects(f2, L()), /missing|refused/);
  for (const sfx of [".established", ".intent", ".commit", ".history"]) fs.rmSync(f2 + sfx, { force: true });
  await assert.rejects(openOperatorEffects(f2, L()), /missing|refused/);
  assert.equal(fs.existsSync(f2), false);
});

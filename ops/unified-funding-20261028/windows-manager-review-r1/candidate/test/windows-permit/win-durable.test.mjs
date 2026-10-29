// permit r1 acceptance (AUTHORED, NOT RUN). Portable logic of the owned Windows log and the permit journal ONLY: the
// exclusion used here is TEST_inProcessExclusion (not share-mode 0) and fsync is Linux fsync (not FlushFileBuffers).
// Real Windows exclusion/flush/power-loss behaviour is WINDOWS-ACCEPTANCE-PERMIT.md W1-W2.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openOwnedLog, initializeOwnedLog, TEST_inProcessExclusion, WINDOWS_EXCLUSION } from "../../control/windows/vbslike/manager/win-durable.mjs";
import { openPermitJournal } from "../../control/windows/vbslike/manager/permit-journal.mjs";
import { tmp, DEPLOYMENT } from "./helpers/world.mjs";

const P = "enclave-manager-permit/1";
const fresh = (t) => { const f = path.join(tmp(t), "j.log"); initializeOwnedLog(f, { purpose: P }); return f; };

test("exclusive open first; a second owner is refused; the Windows exclusion refuses off Windows", (t) => {
  const f = fresh(t), ex = TEST_inProcessExclusion();
  const a = openOwnedLog(f, { purpose: P, exclusion: ex });
  assert.throws(() => openOwnedLog(f, { purpose: P, exclusion: ex }), /owned by another process/);
  a.release();
  assert.throws(() => a.append("x", {}), /released/);
  openOwnedLog(f, { purpose: P, exclusion: ex }).release();
  if (process.platform !== "win32") assert.throws(() => openOwnedLog(f, { purpose: P, exclusion: WINDOWS_EXCLUSION }), /only on Windows/);
});

test("missing, foreign, corrupt or link-reached journals refuse; nothing defaults to empty", (t) => {
  const dir = tmp(t), ex = TEST_inProcessExclusion();
  assert.throws(() => openOwnedLog(path.join(dir, "absent.log"), { purpose: P, exclusion: ex }));
  const f = fresh(t);
  assert.throws(() => openOwnedLog(f, { purpose: "enclave-permit-guard/1", exclusion: ex }), /purpose/);
  const l = openOwnedLog(f, { purpose: P, exclusion: ex }); l.append("inst", { a: 1 }); l.release();
  const bytes = fs.readFileSync(f, "utf8"); fs.writeFileSync(f, bytes.replace('"a":1', '"a":2'));
  assert.throws(() => openOwnedLog(f, { purpose: P, exclusion: ex }), /chain/);
  const g = fresh(t), link = path.join(dir, "via-link");
  fs.symlinkSync(path.dirname(g), link);
  assert.throws(() => openOwnedLog(path.join(link, path.basename(g)), { purpose: P, exclusion: ex }), /symbolic link|reparse/);
});

test("a torn tail is ambiguous: no write until an explicit owner quarantine, which is recorded and never truncates", (t) => {
  const f = fresh(t), ex = TEST_inProcessExclusion();
  const a = openOwnedLog(f, { purpose: P, exclusion: ex }); a.append("inst", { n: 1 }); a.release();
  fs.appendFileSync(f, '{"seq":3,"prev":"tor');
  const b = openOwnedLog(f, { purpose: P, exclusion: ex });
  assert.ok(b.ambiguous());
  assert.throws(() => b.append("inst", { n: 2 }), /torn tail/);
  assert.throws(() => b.quarantineTornTail("yes"), /confirmation/);
  b.quarantineTornTail("quarantine-exact-torn-tail"); b.append("inst", { n: 2 }); b.release();
  const c = openOwnedLog(f, { purpose: P, exclusion: ex });
  assert.equal(c.ambiguous(), null); assert.equal(c.quarantined(), true);
  assert.ok(fs.readFileSync(f, "utf8").includes('{"seq":3,"prev":"tor'), "the torn bytes are retained");
  c.release();
});

test("a flush failure latches the handle: outcome unknown, no further writes", (t) => {
  const f = fresh(t); let fail = false;
  const fsImpl = { ...fs, constants: fs.constants, fsyncSync: (fd) => { if (fail) throw Object.assign(Error("TEST EIO"), { code: "EIO" }); return fs.fsyncSync(fd); } };
  const a = openOwnedLog(f, { purpose: P, exclusion: TEST_inProcessExclusion(), fsImpl });
  fail = true;
  assert.throws(() => a.append("inst", { n: 1 }), /outcome unknown/);
  fail = false;
  assert.throws(() => a.append("inst", { n: 2 }), /failed/);
  assert.throws(() => a.assertLive(), /failed/);
  a.release();
  openOwnedLog(f, { purpose: P, exclusion: TEST_inProcessExclusion() }).release();   // whatever landed is a valid chain
});

test("permit journal: floors survive a new owner; terminal instances never revive; identity is immutable", (t) => {
  const f = fresh(t), ex = TEST_inProcessExclusion();
  const l1 = openOwnedLog(f, { purpose: P, exclusion: ex }), j1 = openPermitJournal(l1);
  j1.observeAssignment(DEPLOYMENT, 5, 1, null);
  j1.permit(DEPLOYMENT, { generation: 5, revision: 1, sequence: 3, digest: "0x" + "33".repeat(32) });
  const rec = { instanceId: "pp" + "a".repeat(32), deployment: DEPLOYMENT, generation: 5, launchEpoch: "b".repeat(32), vmId: null, state: "staging" };
  j1.putInstance(rec); j1.putInstance({ ...rec, state: "removed" });
  l1.release();
  const j2 = openPermitJournal(openOwnedLog(f, { purpose: P, exclusion: ex }));
  assert.equal(j2.read(DEPLOYMENT).sequence, 3);
  assert.throws(() => j2.permit(DEPLOYMENT, { generation: 5, revision: 1, sequence: 2, digest: "0x" + "22".repeat(32) }), /replay/);
  assert.throws(() => j2.permit(DEPLOYMENT, { generation: 5, revision: 1, sequence: 3, digest: "0x" + "44".repeat(32) }), /equivocation/);
  assert.throws(() => j2.putInstance({ ...rec, state: "staged" }), /never revived/);
  const other = { ...rec, instanceId: "pp" + "c".repeat(32) }; j2.putInstance(other);
  assert.throws(() => j2.putInstance({ ...other, launchEpoch: "d".repeat(32) }), /immutable/);
  assert.throws(() => j2.observeAssignment(DEPLOYMENT, 4, 1, null), /rollback/);
});

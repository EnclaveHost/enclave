// The strict release journal on Windows (2026-10-21, nucbox: "app-funded release not sent: EPERM: operation not
// permitted, fsync"). Measured on that host's NTFS with its own node.exe in a scratch TEMP directory
// (work/recovery-hardening/win-fsync-probe.mjs): fsync of a directory opened read-only -> EPERM; opened r+ -> ok. Here the
// real filesystem is wrapped with exactly that rule, so the writer's choice of handle is what is tested.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strictWriteFile, openReleaseJournal } from "../network/lease-release-journal.mjs";

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "journal-win-")); dirs.push(d); return d; };
/** the real fs, with Windows' directory-flush rule: a directory fd opened read-only cannot be fsynced (EPERM) */
function windowsLikeFs({ failBeforeRename = false } = {}) {
  const ro = new Set(), opened = [];
  return {
    opened,
    ...fs,
    openSync(p, flags, mode) {
      if (!(fs.existsSync(p) && fs.statSync(p).isDirectory())) return fs.openSync(p, flags, mode);
      // the test host is POSIX, where a directory opens read-only only: the requested flag is recorded and the Windows
      // rule (a read-only directory handle cannot be flushed) is applied by fsyncSync
      opened.push(flags);
      const fd = fs.openSync(p, "r");
      if (flags === "r") ro.add(fd);
      return fd;
    },
    fsyncSync(fd) {
      if (ro.has(fd)) throw Object.assign(new Error("EPERM: operation not permitted, fsync"), { code: "EPERM" });
      if (failBeforeRename) throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
      return fs.fsyncSync(fd);
    },
    closeSync(fd) { ro.delete(fd); return fs.closeSync(fd); },
  };
}
const ID = "0x" + "c1".repeat(32);

test("win32: the directory is flushed through a write handle - the write succeeds where a read-only handle gave EPERM", () => {
  const d = scratch(), f = path.join(d, "j.json"), w = windowsLikeFs();
  strictWriteFile(f, '{"v":1}', { fsImpl: w, platform: "win32" });
  assert.equal(fs.readFileSync(f, "utf8"), '{"v":1}');
  assert.deepEqual(w.opened, ["r+"]);
  assert.equal(fs.existsSync(f + ".strict.tmp"), false);
  // POSIX keeps the read-only directory handle (a directory cannot be opened for writing there)
  const p = path.join(scratch(), "j.json"), w2 = windowsLikeFs();
  strictWriteFile(p, '{"v":2}', { fsImpl: { ...w2, fsyncSync: fs.fsyncSync }, platform: "linux" });
  assert.deepEqual(w2.opened, ["r"]);
});

test("the old handle on Windows (reproduced): the rename lands, the flush fails - tagged COMMITTED, and the journal keeps memory = disk", () => {
  const d = scratch(), f = path.join(d, "j.json");
  // platform "linux" on Windows semantics = the read-only directory handle the deployed code used
  const j = openReleaseJournal(f, { fsImpl: windowsLikeFs(), platform: "linux" });
  assert.throws(() => j.begin(ID), (e) => e.code === "EPERM" && e.committed === true);
  const onDisk = JSON.parse(fs.readFileSync(f, "utf8")).releases.map((e) => e.id);
  assert.deepEqual(onDisk, [ID], "the entry is on disk (the rename happened)");
  assert.match(j.hold(ID), /nothing signed yet/, "and held in memory too: the same state a restart reads");
  assert.deepEqual(j.pending().map((e) => [e.id, e.intents.length]), [[ID, 0]]);
});

test("a reloaded entry with NOTHING signed is settled 'unsent' durably once the flush works - never deleted by hand, never called released", () => {
  const d = scratch(), f = path.join(d, "j.json");
  const broken = openReleaseJournal(f, { fsImpl: windowsLikeFs(), platform: "linux" });
  assert.throws(() => broken.begin(ID));
  const j = openReleaseJournal(f, { fsImpl: windowsLikeFs(), platform: "win32" });   // the fixed writer, after a restart
  assert.match(j.hold(ID), /nothing signed yet/);
  const e = j.pending().find((x) => x.id === ID);
  assert.equal(e.intents.length, 0, "only an entry with NO signed lease may be settled as unsent");
  j.settle(ID, "unsent");
  assert.equal(j.hold(ID), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")).releases, [], "settled on disk");
  // and a release can be journaled again, durably
  j.begin(ID);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")).releases.map((x) => x.id), [ID]);
});

test("a failure BEFORE the rename changes nothing: not on disk, not held, nothing to settle", () => {
  const d = scratch(), f = path.join(d, "j.json");
  const j = openReleaseJournal(f, { fsImpl: windowsLikeFs({ failBeforeRename: true }), platform: "win32" });
  assert.throws(() => j.begin(ID), (e) => e.code === "EIO" && !e.committed);
  assert.equal(fs.existsSync(f), false);
  assert.equal(j.hold(ID), null);
});

test("a COMMITTED failure while recording a signed lease keeps that intent held (the lease is not sent; the chain fences it later)", () => {
  const d = scratch(), f = path.join(d, "j.json");
  let broken = false;
  const w = windowsLikeFs();
  const fsImpl = { ...w, openSync: (p, flags, mode) => w.openSync(p, broken && fs.existsSync(p) && fs.statSync(p).isDirectory() ? "r" : flags, mode) };
  const j = openReleaseJournal(f, { fsImpl, platform: "win32" });
  j.begin(ID);
  broken = true;
  const s = { payee: "0x" + "11".repeat(20), nonce: 7n, deadline: 99n, kind: 3, lease: { enclaveId: "0x" + "00".repeat(32), maxChargeWei: 5n }, fromBlock: 1n,
    operator: "0x" + "22".repeat(20), chainId: 8453, reserve: "0x" + "33".repeat(20), executor: "0x" + "44".repeat(20), ledger: "0x" + "55".repeat(20) };
  assert.throws(() => j.signed(ID, s), (e) => e.committed === true);
  assert.equal(j.pending()[0].intents.length, 1, "memory keeps the intent the disk has");
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).releases[0].intents.length, 1);
  assert.match(j.hold(ID), /lease nonce 7/);
});

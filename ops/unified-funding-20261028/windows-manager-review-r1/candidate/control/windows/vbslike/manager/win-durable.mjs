/* ============================================================
   An OWNED, append-only, hash-chained journal for Windows (permit r1, SOURCE ONLY - authored, not run).

   WHY NOT owned-durable-state.mjs. That module's exclusion is /usr/bin/flock (runtime-lock.mjs) and its
   durability relies on directory fsync and rename-over; neither exists on Windows/NTFS in that form
   (opening a directory for fsync fails there, and a rename does not make a directory entry durable the way
   POSIX dir fsync does). Porting it by swapping the lock would be the "Linux flock imported as if portable"
   failure this task forbids. So this is a separate, smaller design whose every primitive is a Windows one:

   EXCLUSION. The journal FILE ITSELF is opened with libuv's UV_FS_O_EXLOCK (CreateFileW share mode 0). While
   this process holds the handle no other process can open, rename or delete the file; the kernel closes the
   handle (ending ownership) when the process dies. There is no detached lockfile, no PID marker, no stale
   lock to clear. Ownership is the handle: the returned object is the capability, and every read and write
   goes through that exact handle. The bytes are read only AFTER the exclusive open succeeds.

   DURABILITY. Records are appended to the held handle at its current end and FlushFileBuffers'd
   (fs.fsyncSync on Windows) before append() returns. No rename, no temp file, no directory sync is relied on.
   Callers write an INTENT record and only after append() returns start the side effect it describes.
   Any write/flush/close error LATCHES the handle failed: the bytes may or may not be on disk, so the handle is
   never used again and the next owner sees whatever landed. Every intent kind is designed so that finding it
   present without its effect is the conservative reading (pending launch => survey before absent; pending
   removal => still owned), so a landed-but-unacknowledged intent can never grant anything.

   TORN TAIL. A final line without its newline is AMBIGUOUS: open succeeds for read-only inspection but the
   handle refuses every append until an explicit, owner-held quarantine records the exact torn bytes (offset,
   length, sha256). Nothing is truncated, reset or rewritten; quarantine marks `quarantined` so the layer above
   treats every protected instance as unknown until a real backend survey reconciles it.

   MISSING / CORRUPT. Production never creates a missing journal: initializeOwnedLog() is an explicit install
   step. A missing, empty, chain-broken or foreign-format journal refuses; it is never defaulted to empty.

   STORAGE. Path checks here (absolute local drive path, no UNC/device namespace, no symlink/junction in any
   ancestor - libuv reports junctions and symlinks as symbolic links - regular file with one link). ACL,
   filesystem (NTFS) and fixed-drive checks need the OS: checkWindowsStorage() runs a bounded PowerShell probe
   and compares the exact SDDL the install script set. A probe failure refuses.

   WHAT THIS IS NOT. No protection from an administrator of this host (T0-hv: the host is inside every
   domain's trust boundary). No claim of NTFS crash semantics beyond FlushFileBuffers; real Windows power-loss
   behaviour is an acceptance item (WINDOWS-ACCEPTANCE-PERMIT.md), not proven by any Linux test.
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const LOG_FORMAT = "enclave-win-owned-log/1";
const MAX_BYTES = 8 * 1024 * 1024, ADMISSION_BYTES = 7 * 1024 * 1024;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const digestOf = ({ seq, prev, kind, data }) => sha(JSON.stringify({ seq, prev, kind, data }));
const KIND = /^[a-z][a-z0-9-]{0,63}$/;

/** The real Windows exclusion: CreateFileW with share mode 0 through libuv. Refuses anywhere else. */
export const WINDOWS_EXCLUSION = Object.freeze({
  name: "windows-exlock",
  open(file, fsImpl = fs, platform = process.platform) {
    const ex = fsImpl.constants?.UV_FS_O_EXLOCK;
    if (platform !== "win32" || !Number.isInteger(ex)) throw Error("UV_FS_O_EXLOCK exclusion is available only on Windows");
    try { return fsImpl.openSync(file, fsImpl.constants.O_RDWR | ex); }
    catch (e) {
      if (["EBUSY", "EPERM", "EACCES"].includes(e.code)) throw Object.assign(Error(`journal is owned by another process (${e.code})`), { code: "JOURNAL_OWNED" });
      throw e;
    }
  },
});

/**
 * TEST ONLY (portable Linux tests): an in-process registry imitating share-mode-0 exclusion for ONE process.
 * It proves the journal logic, never Windows exclusion; handles opened with it report exclusion "TEST-in-process"
 * and the enforcement layer refuses to advertise a production capability on them.
 */
export function TEST_inProcessExclusion() {
  const held = new Set();
  return Object.freeze({
    name: "TEST-in-process",
    open(file, fsImpl = fs) {
      const key = path.resolve(file);
      if (held.has(key)) throw Object.assign(Error("journal is owned by another process (TEST)"), { code: "JOURNAL_OWNED" });
      const fd = fsImpl.openSync(file, "r+");
      held.add(key);
      return { fd, release: () => held.delete(key) };
    },
  });
}

/** Local drive path, no UNC/device namespace, no reparse point (symlink/junction) in the file or any ancestor. */
export function checkLocalPath(file, { fsImpl = fs, platform = process.platform } = {}) {
  const p = String(file);
  if (platform === "win32") {
    if (!/^[A-Za-z]:\\/.test(p) || p.startsWith("\\\\") || /[<>"|?*]/.test(p.slice(2))) throw Error("journal path must be a local drive path (no UNC or device namespace)");
  } else if (!path.isAbsolute(p)) throw Error("absolute journal path required");
  const abs = path.resolve(p);
  let cur = abs;
  for (;;) {
    const st = fsImpl.lstatSync(cur);
    if (st.isSymbolicLink()) throw Error(`reparse point or symbolic link in journal path: ${cur}`);
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  const st = fsImpl.lstatSync(abs);
  if (!st.isFile() || st.nlink !== 1) throw Error("journal must be a regular file with exactly one link");
  return abs;
}

/** PowerShell probe of the journal's ACL, filesystem and drive type. Bounded; read-only. */
export function storageProbeScript(file) {
  const q = "'" + String(file).replace(/'/g, "''") + "'";
  return `$ErrorActionPreference='Stop'; $i = Get-Item -LiteralPath ${q} -Force;
    $v = Get-Volume -FilePath ${q};
    @{ sddl=(Get-Acl -LiteralPath ${q}).Sddl; parentSddl=(Get-Acl -LiteralPath $i.DirectoryName).Sddl;
       reparse=[bool]($i.Attributes -band [IO.FileAttributes]::ReparsePoint); fileSystem=[string]$v.FileSystem;
       driveType=[string]$v.DriveType } | ConvertTo-Json -Compress`.replace(/\r?\n\s*/g, " ");
}
/** run: psrun.mjs powershellRunner(); expected: the exact SDDL strings install-guard.ps1 sets. */
export async function checkWindowsStorage(run, file, { sddl, parentSddl }) {
  const r = await run(storageProbeScript(file));
  let j; try { j = JSON.parse(String(r.stdout || "").trim()); } catch { throw Error("storage probe returned no JSON: refusing"); }
  if (r.code !== 0) throw Error(`storage probe failed (${r.code}): refusing`);
  if (j.reparse !== false || j.fileSystem !== "NTFS" || j.driveType !== "Fixed") throw Error("journal must be a non-reparse file on a fixed NTFS volume");
  if (j.sddl !== sddl || j.parentSddl !== parentSddl) throw Error("journal ACL differs from the installed protected ACL");
  return j;
}

function parseLog(text) {
  const lines = text.split("\n");
  const tail = lines.pop();                         // "" when the log ends with its newline
  const out = [];
  let prev = null, seq = 0, offset = 0, pendingBad = null;
  for (const line of lines) {
    const at = offset; offset += Buffer.byteLength(line) + 1;
    let row = null; try { row = JSON.parse(line); } catch {}
    if (!row || typeof row !== "object") {
      if (pendingBad) throw Error("journal chain broken: more than one unreadable record");
      pendingBad = { offset: at, length: Buffer.byteLength(line), sha256: sha(line) };
      continue;
    }
    const { digest, ...data } = row;
    if (row.seq !== seq || row.prev !== prev || digest !== digestOf(data) || !KIND.test(String(row.kind))) throw Error("journal chain broken");
    if (pendingBad) {
      const q = row.data;
      if (row.kind !== "torn-tail-quarantine" || q?.offset !== pendingBad.offset || q?.length !== pendingBad.length || q?.sha256 !== pendingBad.sha256)
        throw Error("journal chain broken: unreadable record without its exact quarantine");
      pendingBad = null;
    }
    if (seq === 0 && (row.kind !== "genesis" || row.data?.format !== LOG_FORMAT)) throw Error("journal is not an owned Windows log");
    out.push(row); prev = digest; seq++;
  }
  if (pendingBad) throw Error("journal chain broken: unreadable record");
  if (!out.length) throw Error("empty journal");
  const torn = tail === "" ? null : { offset, length: Buffer.byteLength(tail), sha256: sha(tail) };
  return { rows: out, torn };
}

/** Explicit install step (never at production startup). Refuses an existing file. */
export function initializeOwnedLog(file, { purpose, fsImpl = fs }) {
  if (typeof purpose !== "string" || !purpose) throw Error("journal purpose required");
  const data = { seq: 0, prev: null, kind: "genesis", data: { format: LOG_FORMAT, purpose, createdAt: Date.now(), id: randomUUID() } };
  const fd = fsImpl.openSync(file, "wx", 0o600);
  try { fsImpl.writeSync(fd, JSON.stringify({ ...data, digest: digestOf(data) }) + "\n"); fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
}

/**
 * openOwnedLog(file, { purpose, exclusion, fsImpl, platform }) -> handle
 * handle: { exclusion, ownerId, rows(), last(), append(kind, data, {admission}), assertLive(), failed(), ambiguous(),
 *           quarantined(), quarantineTornTail(confirm), release() }
 */
export function openOwnedLog(file, { purpose, exclusion = WINDOWS_EXCLUSION, fsImpl = fs, platform = process.platform } = {}) {
  const abs = checkLocalPath(file, { fsImpl, platform });
  const opened = exclusion.open(abs, fsImpl, platform);             // exclusive FIRST; nothing has been read yet
  const fd = typeof opened === "number" ? opened : opened.fd;
  const releaseExclusion = typeof opened === "number" ? () => {} : opened.release;
  let failed = null, released = false, rows, torn, size;
  const ownerId = `${process.pid}:${randomUUID()}`;
  const close = () => { if (released) return; released = true; try { fsImpl.closeSync(fd); } finally { releaseExclusion(); } };
  try {
    size = fsImpl.fstatSync(fd).size;
    if (size < 1 || size > MAX_BYTES) throw Error("journal size out of range: refusing (never defaulted to empty)");
    const buf = Buffer.alloc(size); let got = 0;
    while (got < size) { const n = fsImpl.readSync(fd, buf, got, size - got, got); if (n <= 0) throw Error("short journal read"); got += n; }
    ({ rows, torn } = parseLog(buf.toString("utf8")));
    if (rows[0].data.purpose !== purpose) throw Error(`journal purpose is ${rows[0].data.purpose}, not ${purpose}`);
  } catch (e) { close(); throw Object.assign(Error(`owned journal unavailable: ${e.message}`), { code: e.code ?? "JOURNAL_INVALID" }); }
  const latch = (why) => { failed ??= why; throw Error(`owned journal failed: ${failed}`); };
  function write(kind, data) {
    if (released) throw Error("owned journal released: no write without ownership");
    if (failed) latch(failed);
    const last = rows[rows.length - 1];
    const rec = { seq: last.seq + 1, prev: last.digest, kind, data };
    const line = JSON.stringify({ ...rec, digest: digestOf(rec) }) + "\n";
    const bytes = Buffer.from(line);
    if (size + bytes.length > MAX_BYTES) throw Error("journal full: maintenance required");
    try {
      let off = 0;
      while (off < bytes.length) { const n = fsImpl.writeSync(fd, bytes, off, bytes.length - off, size + off); if (n <= 0) throw Error("short write"); off += n; }
      fsImpl.fsyncSync(fd);
    } catch (e) { latch(`append/flush failed (outcome unknown, record may have landed): ${e.message}`); }
    size += bytes.length; rows.push(JSON.parse(line));
    return rows[rows.length - 1];
  }
  const handle = {
    exclusion: exclusion.name, ownerId, file: abs,
    rows: () => rows.map((r) => structuredClone(r)),
    last: () => structuredClone(rows[rows.length - 1]),
    failed: () => failed, ambiguous: () => torn, released: () => released,
    quarantined: () => rows.some((r) => r.kind === "torn-tail-quarantine"),
    assertLive() {
      if (released) throw Error("owned journal released");
      if (failed) throw Error(`owned journal failed: ${failed}`);
      try { fsImpl.fstatSync(fd); } catch (e) { latch(`held handle lost: ${e.message}`); }
    },
    append(kind, data, { admission = false } = {}) {
      if (!KIND.test(kind) || kind === "genesis" || kind === "torn-tail-quarantine") throw Error("invalid journal record kind");
      if (torn) throw Error("journal has a torn tail: explicit owner quarantine required before any write");
      if (admission && size > ADMISSION_BYTES) throw Error("journal near capacity: no new admission until maintenance");
      handle.assertLive();
      return write(kind, structuredClone(data));
    },
    /** Explicit owner action. Records the exact torn bytes; never truncates. */
    quarantineTornTail(confirm) {
      if (confirm !== "quarantine-exact-torn-tail") throw Error("explicit quarantine confirmation required");
      if (!torn) throw Error("no torn tail");
      handle.assertLive();
      // terminate the torn line so it becomes the single unreadable line that the quarantine record names
      try { const nl = Buffer.from("\n"); if (fsImpl.writeSync(fd, nl, 0, 1, size) !== 1) throw Error("short write"); fsImpl.fsyncSync(fd); }
      catch (e) { latch(`quarantine newline failed: ${e.message}`); }
      size += 1; const q = torn; torn = null;
      return write("torn-tail-quarantine", q);
    },
    /** Ends ownership: the handle closes and every later use refuses. */
    release() { close(); },
  };
  // Boot verification under the held handle: flush what was read, then an owner provenance record.
  if (!torn) {
    try { fsImpl.fsyncSync(fd); } catch (e) { failed = `open verification flush failed: ${e.message}`; }
    if (!failed) try { write("open-verified", { ownerId, pid: process.pid, at: Date.now(), exclusion: exclusion.name }); } catch { /* latched */ }
  }
  return handle;
}

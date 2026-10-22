// TEST-ONLY (node --import, test processes only): fail, shorten or audit the ACTUAL supervisor's state writes. Wraps
// node:fs openSync/closeSync/writeSync/fsyncSync/renameSync and republishes them to ESM importers
// (module.syncBuiltinESMExports), so the supervisor's own `import { ... } from "node:fs"` sees them.
//   TEST_FS_FAULT_CTL: a control file {"id", "op", "when"}; op is one of
//     write | fsync-file | rename | fsync-dir  - that step fails with EIO
//     short-write                              - each write call writes at most 7 bytes (a legal short write)
//     zero-write                               - each write call reports 0 bytes written (no progress)
//   when "sponsored": only a save whose content carries a sponsored release attempt is affected (so the open intent
//   itself still reaches disk); otherwise every save of the state file is.
//   TEST_FS_AUDIT: a file that gets one JSON line per replacement of the state file: {src, fsynced} - a replacement
//   by a temp file that was never fsynced is a durability violation, whatever wrote it.
// Only the supervisor's state temp files and its state directory are touched.
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const ctl = process.env.TEST_FS_FAULT_CTL, audit = process.env.TEST_FS_AUDIT, stateFile = process.env.STATE_FILE;
if ((ctl || audit) && stateFile) {
  const state = path.resolve(stateFile), dir = path.dirname(state);
  const isTmp = (p) => p.startsWith(state + ".") && p.endsWith(".tmp");
  const fdPath = new Map(), fsynced = new Set(), marked = new Set();
  let lastMarked = false;
  const control = () => { if (!ctl) return null; try { return JSON.parse(fs.readFileSync(ctl, "utf8")); } catch { return null; } };
  const active = (op, isMarked) => { const c = control(); return !!c && c.op === op && (c.when !== "sponsored" || isMarked); };
  const eio = (op, p) => Object.assign(new Error(`EIO: injected ${op} failure, ${p}`), { code: "EIO", errno: -5, syscall: op });
  const { openSync, closeSync, writeSync, fsyncSync, renameSync } = fs;
  fs.openSync = function (p, ...rest) {
    const fd = openSync.call(fs, p, ...rest);
    const abs = path.resolve(String(p));
    if (isTmp(abs) || abs === dir) { fdPath.set(fd, abs); if (isTmp(abs)) { fsynced.delete(abs); marked.delete(abs); } }
    return fd;
  };
  fs.closeSync = function (fd) { fdPath.delete(fd); return closeSync.call(fs, fd); };
  fs.writeSync = function (fd, buf, ...rest) {
    const p = fdPath.get(fd);
    if (p && p !== dir) {
      if (Buffer.isBuffer(buf) ? buf.includes('"sponsored":true') : String(buf).includes('"sponsored":true')) marked.add(p);
      const m = marked.has(p);
      if (active("write", m)) throw eio("write", p);
      if (active("zero-write", m)) return 0;
      if (active("short-write", m) && Buffer.isBuffer(buf) && typeof rest[0] === "number") {
        const [offset, length] = rest;
        return writeSync.call(fs, fd, buf, offset, Math.min(7, length ?? buf.length - offset));
      }
    }
    return writeSync.call(fs, fd, buf, ...rest);
  };
  fs.fsyncSync = function (fd) {
    const p = fdPath.get(fd);
    if (p && p !== dir && active("fsync-file", marked.has(p))) throw eio("fsync", p);
    if (p === dir && active("fsync-dir", lastMarked)) throw eio("fsync", dir);
    const r = fsyncSync.call(fs, fd);
    if (p && p !== dir) fsynced.add(p);
    return r;
  };
  fs.renameSync = function (a, b) {
    const src = path.resolve(String(a)), dst = path.resolve(String(b));
    if (isTmp(src) && active("rename", marked.has(src))) throw eio("rename", src);
    const r = renameSync.call(fs, a, b);
    if (dst === state) {
      lastMarked = marked.has(src);
      if (audit) fs.appendFileSync(audit, JSON.stringify({ src, fsynced: fsynced.has(src) }) + "\n");
    }
    return r;
  };
  syncBuiltinESMExports();
  console.log(`[fixture] state-write fault injector armed (control ${ctl || "-"}, audit ${audit || "-"})`);
}

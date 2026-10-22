// Guarded Windows scratch probe (no Enclave file, config, key or state is read or written): which durability calls
// Node supports on this host's filesystem for a write-temp / fsync / rename sequence. Everything happens in a NEW
// directory under the caller's TEMP, removed at the end. Prints one JSON object.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const out = { platform: process.platform, node: process.version, probes: {} };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enclave-fsync-probe-"));
const tryIt = (name, f) => { try { out.probes[name] = { ok: true, ...(f() || {}) }; } catch (e) { out.probes[name] = { ok: false, code: e.code || null, message: String(e.message).slice(0, 160) }; } };
try {
  const file = path.join(dir, "journal.json");
  fs.writeFileSync(file, "{}");
  tryIt("A_dir_open_r_fsync", () => { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } });
  tryIt("B_dir_open_rplus_fsync", () => { const fd = fs.openSync(dir, "r+"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } });
  tryIt("C_renamed_file_open_rplus_fsync", () => {
    const tmp = file + ".strict.tmp"; fs.writeFileSync(tmp, '{"v":1}'); fs.renameSync(tmp, file);
    const fd = fs.openSync(file, "r+"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return { readBack: fs.readFileSync(file, "utf8") };
  });
  tryIt("D_full_sequence_twice_over_existing", () => {
    const seq = (text) => {
      const tmp = file + ".strict.tmp", fd = fs.openSync(tmp, "w", 0o600);
      try { fs.writeSync(fd, Buffer.from(text)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
      const f2 = fs.openSync(file, "r+"); try { fs.fsyncSync(f2); } finally { fs.closeSync(f2); }
      return fs.readFileSync(file, "utf8");
    };
    const a = seq('{"v":2}'), b = seq('{"v":3,"releases":[]}');
    return { first: a, second: b, tmpLeft: fs.existsSync(file + ".strict.tmp") };
  });
} finally { fs.rmSync(dir, { recursive: true, force: true }); out.scratchRemoved = !fs.existsSync(dir); }
console.log(JSON.stringify(out));

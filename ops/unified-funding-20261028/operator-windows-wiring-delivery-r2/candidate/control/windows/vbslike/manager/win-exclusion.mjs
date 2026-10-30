/* ============================================================
   Runtime-pinned Windows journal exclusion (permit r2, SOURCE ONLY - authored, not run, NOT QUALIFIED).

   OBSERVED (approved read-only runtime observation): the deployed runtime is Node v24.16.0,
   C:\Program Files\Enclave\runtime\node\node.exe sha256 b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3,
   and fs.constants.UV_FS_O_EXLOCK is ABSENT there. So win-durable.mjs WINDOWS_EXCLUSION (which requires the named
   constant) refuses every Windows open on the deployed runtime: protected capability stays false. That is safe and
   it is NOT usable hosting.

   The bundled libuv defines UV_FS_O_EXLOCK = 0x10000000 (CreateFileW dwShareMode 0). A header value is NOT a
   qualification: Node may mask unknown flag bits before uv_fs_open, and nothing here has observed the deployed
   binary honouring it across processes. This adapter therefore uses the numeric flag ONLY when ALL hold:
     1. process.platform === "win32" and the named constant is absent or equals 0x10000000 (never a different value);
     2. process.version and the sha256 of process.execPath equal NODE_RUNTIME_PIN exactly (hash computed at startup);
     3. an explicit root-produced qualification record (schema below) names exactly this runtime and flag and states
        the cross-process facts it OBSERVED: a second process is refused open/rename/delete while held, and holder
        death releases. Nothing here produces or defaults that record;
     4. after each open, a SECOND open of the same path with the same flag from this process must FAIL with a
        sharing violation (EBUSY/EPERM/EACCES); if it succeeds the flag was ignored: both handles close and the open
        refuses. This in-process check is necessary, not sufficient (that is why 3 exists).
   There is no fallback to an unlocked open and no use of Linux flock. Labels: exclusion name "windows-exlock" with
   basis "numeric-qualified"; enforcement/guard readiness accept only that name.
   ============================================================ */
import fs from "node:fs";
import { createHash } from "node:crypto";

export const UV_FS_O_EXLOCK_NUMERIC = 0x10000000;
export const NODE_RUNTIME_PIN = Object.freeze({
  version: "v24.16.0",
  execPath: "C:\\Program Files\\Enclave\\runtime\\node\\node.exe",
  execSha256: "b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3",
});
export const QUALIFICATION_SCHEMA = "enclave-win-exlock-qualification/1";
const QKEYS = ["schema", "nodeVersion", "execSha256", "flag", "crossProcessOpenRefused", "crossProcessRenameRefused",
  "crossProcessDeleteRefused", "holderDeathReleases", "sameProcessSecondOpenRefused", "evidenceSha256", "qualifiedBy"];
const SHARING = new Set(["EBUSY", "EPERM", "EACCES"]);

export function validateExlockQualification(q, pin = NODE_RUNTIME_PIN) {
  if (!q || typeof q !== "object" || Object.keys(q).length !== QKEYS.length || !QKEYS.every((k) => Object.hasOwn(q, k))) throw Error("EXLOCK qualification has unknown or missing fields");
  if (q.schema !== QUALIFICATION_SCHEMA || q.nodeVersion !== pin.version || q.execSha256 !== pin.execSha256 || q.flag !== UV_FS_O_EXLOCK_NUMERIC)
    throw Error("EXLOCK qualification does not name this exact runtime and flag");
  for (const k of ["crossProcessOpenRefused", "crossProcessRenameRefused", "crossProcessDeleteRefused", "holderDeathReleases", "sameProcessSecondOpenRefused"])
    if (q[k] !== true) throw Error(`EXLOCK qualification did not observe ${k}`);
  if (!/^[0-9a-f]{64}$/.test(q.evidenceSha256 || "") || q.qualifiedBy !== "root") throw Error("EXLOCK qualification evidence/qualifier missing");
  return Object.freeze({ ...q });
}

/** sha256 of the running executable (read once, at startup). */
export function execSha256(file = process.execPath, fsImpl = fs) { return createHash("sha256").update(fsImpl.readFileSync(file)).digest("hex"); }

/**
 * -> an exclusion adapter for win-durable openOwnedLog, or throws (never returns a weaker adapter).
 * runtime: { platform, version, execPath, execSha256 } of THIS process (tests inject; production passes the real ones).
 */
export function windowsNumericExclusion({ qualification, runtime, pin = NODE_RUNTIME_PIN, fsImpl = fs }) {
  const q = validateExlockQualification(qualification, pin);
  if (runtime?.platform !== "win32") throw Error("numeric EXLOCK exclusion is Windows-only");
  const named = fsImpl.constants?.UV_FS_O_EXLOCK;
  if (named !== undefined && named !== UV_FS_O_EXLOCK_NUMERIC) throw Error("runtime UV_FS_O_EXLOCK differs from the qualified numeric flag");
  if (runtime.version !== pin.version || String(runtime.execPath).toLowerCase() !== pin.execPath.toLowerCase() || runtime.execSha256 !== pin.execSha256)
    throw Error("running Node is not the pinned, qualified runtime");
  const flags = fsImpl.constants.O_RDWR | UV_FS_O_EXLOCK_NUMERIC;
  return Object.freeze({
    name: "windows-exlock", basis: `numeric-qualified:${q.evidenceSha256}`,
    open(file) {
      let fd;
      try { fd = fsImpl.openSync(file, flags); }
      catch (e) {
        if (SHARING.has(e.code)) throw Object.assign(Error(`journal is owned by another process (${e.code})`), { code: "JOURNAL_OWNED" });
        throw e;
      }
      // self-check: share mode 0 must refuse even this process's second open
      let second = null, refused = false;
      try { second = fsImpl.openSync(file, flags); } catch (e) { refused = SHARING.has(e.code); if (!refused) { try { fsImpl.closeSync(fd); } catch {} throw Error(`EXLOCK self-check failed unexpectedly (${e.code}): refusing`); } }
      if (!refused) {
        try { fsImpl.closeSync(second); } catch {}
        try { fsImpl.closeSync(fd); } catch {}
        throw Object.assign(Error("EXLOCK flag was ignored by this runtime (a second open succeeded): refusing, no unlocked fallback"), { code: "EXLOCK_UNQUALIFIED" });
      }
      return fd;
    },
  });
}

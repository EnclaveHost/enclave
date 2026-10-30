/* A bounded PowerShell runner: the one place this manager executes anything.
   Separated so every other module stays injectable and testable, and so the bounds - a timeout, a
   kill, an output cap - live in one reviewable place rather than at each call site.

   operator Windows wiring r2 (SOURCE ONLY, AUTHORED, NOT RUN). The r1 runner promised bounds it did not keep (root
   boundary tests 5-7): it ran a RELATIVE "powershell.exe" (PATH lookup), capped each stream separately by JS string
   length after appending a whole chunk, and on timeout only asked for a kill, settling only if the child ever emitted
   close. Now, for every existing caller (manager main.mjs, guard-main.mjs) and the operator-effects config/installer:
     EXECUTABLE. One reviewed absolute Windows PowerShell path. On win32 nothing else is executed (case-insensitive
       equality; no PATH lookup, no environment expansion, no shell). Off Windows (portable tests that intercept spawn,
       nothing to execute) an explicit caller-supplied absolute local drive path to powershell.exe is accepted so
       tests can observe it; no environment variable selects or widens it. No binary hash is claimed here: the
       target file's identity (signature/hash, %SystemRoot% not on C:) is a native qualification item.
     OPTIONS. timeoutMs and maxOutputBytes must be finite integers within fixed bounds, or the runner refuses to build.
     OUTPUT. ONE combined budget of retained UTF-8 BYTES across stdout, stderr and this runner's own diagnostics.
       A chunk is cut at the remaining budget (never appended whole); the retained bytes are decoded so the result is
       never malformed UTF-8 (an incomplete trailing sequence is dropped, an invalid byte becomes "?"), and decoding
       never grows the byte count. Output past the budget is drained and dropped (the child is never blocked on a full
       pipe by us) and reported as outputTruncated.
     TIMEOUT. At the deadline the kill is requested and the caller is SETTLED with code 124 immediately: it never
       waits for an exit or close that may not arrive. Settling is NOT proof the child (or any descendant) ended:
       processState stays "unresolved" until close is observed, and the process stays listed by unresolvedProcesses()
       for callers that must not continue (the installer). Descendants are never tracked by this runner.
     EVENTS. Spawn throws/errors settle with code 127; late data/exit/close/error after settlement are absorbed without
       retaining output or throwing; the timer is cleared on settle. Nothing here blocks or refuses later runs, so
       Stop and read-only callers are never held hostage by an earlier unresolved child.
   The result keeps the existing contract { code, stdout, stderr } and adds { outputTruncated, timedOut, processState }. */
import { spawn } from "node:child_process";

/** the reviewed Windows PowerShell 5.1 path; the ONLY executable this runner starts on win32 */
export const REVIEWED_POWERSHELL_EXE = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
export const TIMEOUT_CODE = 124, SPAWN_FAILED_CODE = 127;
export const MAX_TIMEOUT_MS = 30 * 60_000, MAX_OUTPUT_BYTES = 16 * 1024 * 1024, MAX_TRACKED_UNRESOLVED = 64;

/**
 * The arguments a script is run with. -EncodedCommand, because PowerShell's own quoting eats | and $
 * on the way in and this manager sends scripts full of both.
 *
 * Progress records reach stderr as CLIXML (<Objs ...><Obj S="progress">...), and on a first run in a
 * session "Preparing modules for first use" alone is kilobytes of it. It filled the output cap and
 * buried the actual exception, so a real ModifySystemSettings failure arrived as code=1 with no
 * readable reason. Silencing progress is a DIAGNOSTIC change only: errors, warnings and output are
 * untouched.
 *
 * Exported so a test can hold the longest script (the type-1 definition) under Windows' 32,767-char
 * command-line limit: base64 of UTF-16 is ~2.7 characters per script character.
 */
export function powershellArgs(script) {
  const enc = Buffer.from("$ProgressPreference='SilentlyContinue'; " + String(script), "utf16le").toString("base64");
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc];
}

const refuse = (message) => Object.assign(new Error(message), { code: "PowerShellRunnerRefused" });

/** null, or why `exe` may not be executed here (win32: only the reviewed path; elsewhere: an absolute drive path to powershell.exe) */
export function powershellExecutableProblem(exe) {
  if (typeof exe !== "string" || exe.length > 260) return "PowerShell executable must be a string path";
  if (process.platform === "win32")
    return exe.toLowerCase() === REVIEWED_POWERSHELL_EXE.toLowerCase() ? null : "on Windows only the reviewed absolute Windows PowerShell path is executed (no PATH lookup or override)";
  if (!/^[A-Za-z]:\\/.test(exe) || /[\x00-\x1f"*?<>|/%:]/.test(exe.slice(2)) || exe.slice(3).split("\\").some((s) => s === "" || s === "." || s === ".."))
    return "PowerShell executable must be an absolute local drive path (no PATH lookup, environment expansion, UNC, device or relative form)";
  if (!/\\powershell\.exe$/i.test(exe)) return "PowerShell executable must be powershell.exe";
  return null;
}

// ---- unresolved children (timed out, no close observed). In-process only; never persisted; bounded. ------------------------------------
const UNRESOLVED = new Map();
let untracked = 0;
/** -> { count, tracked: [{ pid, startedAt, timedOutAt, killRequested }] }: direct children settled by timeout whose close was never seen */
export function unresolvedProcesses() {
  return { count: UNRESOLVED.size + untracked, tracked: [...UNRESOLVED.values()].map((x) => ({ ...x })) };
}

/** the longest prefix of buf (at most limit bytes) that ends on a UTF-8 character boundary, decoded without growing */
function boundedUtf8(buf, limit = buf.length) {
  let cut = Math.max(0, Math.min(limit, buf.length));
  if (cut > 0) {
    let j = cut - 1, cont = 0;
    while (j > 0 && cont < 3 && (buf[j] & 0xc0) === 0x80) { j--; cont++; }
    const lead = buf[j], need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (cut - j < need) cut = j;
  }
  // an invalid byte decodes to U+FFFD (3 bytes); "?" keeps every replacement at <= the bytes it replaces
  return new TextDecoder("utf-8").decode(buf.subarray(0, cut)).replace(/\uFFFD/g, "?");
}
const clean = (s) => String(s ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ");

export function powershellRunner({ exe = REVIEWED_POWERSHELL_EXE, timeoutMs = 180_000, maxOutputBytes = 1 << 20 } = {}) {
  const why = powershellExecutableProblem(exe);
  if (why) throw refuse(why);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw refuse(`timeoutMs must be an integer in 1..${MAX_TIMEOUT_MS}`);
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_OUTPUT_BYTES) throw refuse(`maxOutputBytes must be an integer in 1..${MAX_OUTPUT_BYTES}`);
  // part of the one budget is held back so a diagnostic can still be said when the child filled its share
  const room = maxOutputBytes - Math.min(256, Math.floor(maxOutputBytes / 8));
  return function run(script) {
    return new Promise((resolve) => {
      const kept = { stdout: [], stderr: [] }, startedAt = Date.now();
      let used = 0, truncated = false, settled = false, closed = false, timedOut = false, started = false, timer = null, tracked = null, overflowed = false, p;
      const markUnresolved = (killRequested) => {
        if (closed || tracked || overflowed) return;
        if (UNRESOLVED.size < MAX_TRACKED_UNRESOLVED) { tracked = Symbol("unresolved"); UNRESOLVED.set(tracked, { pid: p?.pid ?? null, startedAt, timedOutAt: Date.now(), killRequested }); }
        else { overflowed = true; untracked++; }
      };
      const markResolved = () => {
        if (tracked) { UNRESOLVED.delete(tracked); tracked = null; }
        if (overflowed) { overflowed = false; untracked--; }
      };
      const keep = (stream, chunk) => {
        if (settled) return;                                     // late output is drained and dropped, never retained
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
        if (!b.length) return;
        const take = Math.min(b.length, room - used);
        if (take < b.length) truncated = true;
        if (take > 0) { kept[stream].push(Buffer.from(b.subarray(0, take))); used += take; }   // a copy: the child's chunk is not held
      };
      const settle = (code, diagnostic) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        const stdout = boundedUtf8(Buffer.concat(kept.stdout)), err = boundedUtf8(Buffer.concat(kept.stderr));
        const left = maxOutputBytes - Buffer.byteLength(stdout) - Buffer.byteLength(err);
        const diag = diagnostic ? boundedUtf8(Buffer.from(`${clean(diagnostic)}\n`), left) : "";
        const processState = !started ? "not-started" : closed ? "exited" : "unresolved";
        resolve({ code, stdout, stderr: diag + err, outputTruncated: truncated, timedOut, processState });
      };
      const onClose = (code, signal) => {
        closed = true;
        markResolved();
        settle(Number.isInteger(code) ? code : 1, Number.isInteger(code) ? null : `terminated by ${clean(signal || "an unknown signal")}`);
      };
      try {
        p = spawn(exe, powershellArgs(script), { windowsHide: true, shell: false });
      } catch (e) { settle(SPAWN_FAILED_CODE, `spawn failed: ${e?.code || ""} ${e?.message || ""}`.trim()); return; }
      started = true;
      for (const name of ["stdout", "stderr"]) {
        const s = p[name];
        if (!s) continue;
        s.on("data", (d) => keep(name, d));
        s.on("error", () => {});                                 // a broken pipe is not a crash; the result already says what it can
      }
      p.on("error", (e) => {
        if (settled) return;                                     // e.g. a kill that failed after the timeout: absorbed
        if (p.pid === undefined) started = false;                // never spawned (ENOENT, EACCES)
        else markUnresolved(false);                              // spawned, then an error without close: not proof it ended
        settle(SPAWN_FAILED_CODE, `PowerShell could not be run: ${e?.code || ""} ${e?.message || ""}`.trim());
      });
      p.on("close", onClose);
      timer = setTimeout(() => {
        timedOut = true;
        let killRequested = false;
        try { killRequested = p.kill() === true; } catch {}
        markUnresolved(killRequested);
        settle(TIMEOUT_CODE, `timed out after ${timeoutMs}ms; kill ${killRequested ? "requested" : "not accepted"}; process exit unconfirmed`);
      }, timeoutMs);
    });
  };
}

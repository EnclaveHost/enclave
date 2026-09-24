/* A bounded PowerShell runner: the one place this manager executes anything.
   Separated so every other module stays injectable and testable, and so the bounds - a timeout, a
   kill, an output cap - live in one reviewable place rather than at each call site. */
import { spawn } from "node:child_process";

export function powershellRunner({ exe = "powershell.exe", timeoutMs = 180_000, maxOutputBytes = 1 << 20 } = {}) {
  return function run(script) {
    return new Promise((resolve) => {
      // -EncodedCommand, because PowerShell's own quoting eats | and $ on the way in and this
      // manager sends scripts full of both.
      // Progress records reach stderr as CLIXML (<Objs ...><Obj S="progress">...), and on a first
      // run in a session "Preparing modules for first use" alone is kilobytes of it. It filled the
      // output cap and buried the actual exception, so a real ModifySystemSettings failure arrived
      // as code=1 with no readable reason. Silencing progress is a DIAGNOSTIC change only: errors,
      // warnings and output are untouched.
      const enc = Buffer.from("$ProgressPreference='SilentlyContinue'; " + String(script), "utf16le").toString("base64");
      const p = spawn(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc],
                      { windowsHide: true });
      let out = "", err = "", done = false, killed = false;
      const cap = (s, add) => (s.length >= maxOutputBytes ? s : s + add);
      const timer = setTimeout(() => { killed = true; try { p.kill(); } catch {} }, timeoutMs);
      p.stdout.on("data", (d) => { out = cap(out, d.toString("utf8")); });
      p.stderr.on("data", (d) => { err = cap(err, d.toString("utf8")); });
      const finish = (code) => {
        if (done) return; done = true; clearTimeout(timer);
        resolve({ code: killed ? 124 : code, stdout: out, stderr: killed ? `timed out after ${timeoutMs}ms\n${err}` : err });
      };
      p.on("error", (e) => { err = cap(err, String(e && e.message)); finish(127); });
      p.on("close", finish);
    });
  };
}

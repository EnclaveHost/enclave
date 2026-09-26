// The hv-node rollout's PowerShell scripts, checked where no Windows is at hand (windows/node/ops/hv-node-rollout).
// 1. PowerShell 5.1 UNROLLS a function's @(…) result at the call site when it holds ONE element: the caller gets the
//    bare object, and a CimInstance's .Count is then EMPTY, not 1. enclave-d1 measured it on the box (04:58Z, -NodeOnly at
//    efd1ac677): `(Procs …).Count` never saw the new agent (a false "NOT UP"), and the gone-check read "none" while one
//    process still ran, which would have let run-node.cmd be rewritten under a live loop. hvnode-accept's A2 hit the same
//    class (v2.2.2). So every call of a function whose body is @(…) must be wrapped again, @(Name …), or be a scriptblock
//    reference ${function:Name} whose invoker wraps it, @(& $sb).
// 2. Each script parses, when a pwsh is available (ENCLAVE_PWSH, or ~/enclave-bench/tools/pwsh-*/pwsh); else skipped.
//   run: node --test test/hvnode-install-ps1.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(REPO, "windows", "node", "ops", "hv-node-rollout");
const scripts = [...fs.readdirSync(DIR), ...fs.readdirSync(path.join(DIR, "canary")).map((f) => path.join("canary", f))]
  .filter((f) => f.endsWith(".ps1"));

// the unwrapped calls of every @(…)-returning function in a script: [line, text]
function unwrapped(src) {
  const names = [...src.matchAll(/^\s*function\s+([A-Za-z][\w-]*)\s*(?:\([^)]*\))?\s*\{\s*@\(/gm)].map((m) => m[1]);
  const bad = [];
  src.split("\n").forEach((line, i) => {
    if (/^\s*#/.test(line)) return;                                      // a comment line
    for (const n of names) {
      const re = new RegExp(`(^|[^\\w-])${n}(?![\\w-])`, "g");
      for (let m; (m = re.exec(line));) {
        const at = m.index + m[1].length, before = line.slice(0, at);
        if (/function\s+$/.test(before)) continue;                       // its definition
        if (/@\(\s*$/.test(before)) continue;                            // @(Name …)
        if (/\$\{function:$/.test(before)) continue;                     // a scriptblock reference
        bad.push([i + 1, line.trim()]);
      }
    }
  });
  return bad;
}

test("every call of an @(…)-returning function is wrapped again, @(Name …): PowerShell 5.1 unrolls a one-element result", () => {
  const found = scripts.flatMap((f) => unwrapped(fs.readFileSync(path.join(DIR, f), "utf8")).map(([l, t]) => `${f}:${l}: ${t}`));
  assert.deepEqual(found, []);
});

test("the check itself catches the efd1ac677 forms (a bare call, .Count on a bare call, a foreach over one)", () => {
  const src = [
    "function Procs([string]$n) { @(Get-CimInstance Win32_Process) }",
    "if ((Procs 'node.exe').Count) { }",
    "if (-not (Procs 'cmd.exe').Count -and -not @(Procs 'x').Count) { }",
    "foreach ($p in (Procs 'a')) { }",
    "$ok = @(Procs 'b'); Recover 'x' ${function:Procs}",
    "# a comment naming (Procs 'c').Count is not a call",
  ].join("\n");
  assert.deepEqual(unwrapped(src).map(([l]) => l), [2, 3, 4]);
});

const pwsh = process.env.ENCLAVE_PWSH || (() => {
  const tools = path.join(os.homedir(), "enclave-bench", "tools");
  try { const d = fs.readdirSync(tools).filter((x) => x.startsWith("pwsh-")).sort().pop(); return d ? path.join(tools, d, "pwsh") : null; }
  catch { return null; }
})();
test("each rollout script parses (pwsh's parser)", { skip: !pwsh || !fs.existsSync(pwsh) ? "no pwsh here" : false }, () => {
  for (const f of scripts) {
    const p = path.join(DIR, f).replace(/'/g, "''");
    const out = execFileSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command",
      `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${p}',[ref]$null,[ref]$e); if ($e.Count) { $e | ForEach-Object { 'L' + $_.Extent.StartLineNumber + ': ' + $_.Message } } else { 'OK' }`],
      { encoding: "utf8", timeout: 60_000 }).trim();
    assert.equal(out, "OK", `${f}: ${out}`);
  }
});

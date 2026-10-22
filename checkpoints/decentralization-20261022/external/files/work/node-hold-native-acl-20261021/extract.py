#!/usr/bin/env python3
"""Extract EXACTLY the functions Sha, ProtectedTemp, CasWrite from the pinned helper node-hold-cutover.ps1 e369c5e2 with
PowerShell's own AST (Parser.ParseFile -> FunctionDefinitionAst.Extent.Text). The helper is PARSED, never executed.
Writes functions.ps1 (verbatim function texts, in that order) + functions.json (helper sha, each function's sha256)."""
import hashlib, json, pathlib, subprocess, sys
H = pathlib.Path(__file__).resolve().parent
W = H.parent; HELPER = W / "node-hold-package-20261021/helper/node-hold-cutover.ps1"
PIN = "e369c5e204f4d0fe9c6277a7237d7f0ddae6beea6a1bfe935825481b34c6ac45"
PWSH = W / "node-hold-package-20261021/tools/pwsh/pwsh"
NAMES = ["Sha", "ProtectedTemp", "CasWrite"]
if hashlib.sha256(HELPER.read_bytes()).hexdigest() != PIN: sys.exit("helper is not the pinned e369c5e2")
ps = ("$e=$null;$t=$null;$a=[System.Management.Automation.Language.Parser]::ParseFile('" + str(HELPER) + "',[ref]$t,[ref]$e);"
      "if($e.Count){throw 'parse errors'};$o=[ordered]@{};"
      "foreach($n in @('" + "','".join(NAMES) + "')){$f=@($a.FindAll({param($x) $x -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $n},$true));"
      "if($f.Count -ne 1){throw ""function $n found $($f.Count) times""};$o[$n]=$f[0].Extent.Text};$o|ConvertTo-Json -Compress")
r = subprocess.run([str(PWSH), "-NoProfile", "-NonInteractive", "-Command", ps], capture_output=True, text=True, timeout=120)
if r.returncode: sys.exit(r.stderr[-800:])
fx = json.loads(r.stdout)
src = HELPER.read_text()
for n in NAMES: assert fx[n] in src, f"{n}: AST extent is not a verbatim substring of the helper"
text = "\n".join(fx[n] for n in NAMES) + "\n"
(H / "functions.ps1").write_text(text, newline="\n")
meta = {"helper": str(HELPER), "helperSha256": PIN, "method": "PowerShell 7.4.6 Parser.ParseFile FunctionDefinitionAst.Extent.Text (verbatim, asserted as substring)",
        "functions": {n: hashlib.sha256(fx[n].encode()).hexdigest() for n in NAMES}, "functionsPs1Sha256": hashlib.sha256(text.encode()).hexdigest()}
(H / "functions.json").write_text(json.dumps(meta, indent=1) + "\n"); print(json.dumps(meta, indent=1)); print(text)

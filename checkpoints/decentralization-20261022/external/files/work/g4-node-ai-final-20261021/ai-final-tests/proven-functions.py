#!/usr/bin/env python3
"""ProtectedTemp / CasWrite / Sha must stay BYTE-IDENTICAL to the natively proven extents (functions.json: helper e369c5e2,
PowerShell 7.4 Parser FunctionDefinitionAst.Extent.Text). Parses only; never runs the script."""
import hashlib, json, pathlib, subprocess, sys
P = pathlib.Path(__file__).resolve().parent.parent; W = P.parent
want = json.loads((W / "node-hold-acl-normalization-20261021/fixture-v2/functions.json").read_text())["functions"]
rc = 0
for script in (P / "helper/node-hold-cutover.ps1", W / "g4-node-final-package-20261021/helper/node-hold-cutover.ps1"):
    r = subprocess.run([str(P / "tools/pwsh/pwsh"), "-NoProfile", "-NonInteractive", "-Command",
        f"$e=$null;$a=[System.Management.Automation.Language.Parser]::ParseFile('{script}',[ref]$null,[ref]$e);"
        "$o=[ordered]@{errors=$e.Count};foreach($f in $a.FindAll({param($x) $x -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)){if('Sha','ProtectedTemp','CasWrite' -contains $f.Name){$o[$f.Name]=$f.Extent.Text}};$o|ConvertTo-Json -Compress"],
        capture_output=True, text=True, timeout=120)
    got = json.loads(r.stdout); res = {k: hashlib.sha256(got[k].encode()).hexdigest() for k in want}
    ok = got["errors"] == 0 and res == want; rc |= not ok
    print(script.relative_to(W), hashlib.sha256(script.read_bytes()).hexdigest()[:16], "parse errors", got["errors"], {k: v[:8] for k, v in res.items()}, "IDENTICAL to native-proven" if ok else "DIFFERENT")
sys.exit(rc)

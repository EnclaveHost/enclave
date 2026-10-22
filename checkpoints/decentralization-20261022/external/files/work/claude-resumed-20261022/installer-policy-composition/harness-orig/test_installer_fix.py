#!/usr/bin/env python3
"""tools/test_installer_fix.py - install-host.ps1's node-config.cmd generator RENDERED by pwsh (its exact here-string, dummy inputs),
then classified with the postflight A1 rule (last ENCLAVE_PLATFORM_HOST_POLICY assignment: production/off/json/empty/other/unset).
OLD NEGATIVE CONTROL: the frozen generator (0dc5a801) renders 'unset' (= OFF on the Windows node: host.mjs passes book:null)."""
import os, pathlib, re, subprocess, unittest
A = pathlib.Path(__file__).resolve().parents[1]
PWSH = os.environ.get("PWSH") or str(A.parents[1] / "node-hold-package-20261021/tools/pwsh/pwsh")
OLD, NEW = A / "source-fix/install-host.ps1.orig", A / "source-fix/install-host.ps1"
VARS = ("$Name='nucbox-k11-4';$Referral='';$want=[pscustomobject]@{publicUrl='https://api.enclave.host/t/nucbox-k11-4';relay='https://api.enclave.host';rpcs=@();gateways=@();checkers=@();directories=@()};"
        "$independent=$false;$PD='C:\\ProgramData\\Enclave';$PF='C:\\Program Files\\Enclave';$runtimeId='r';$Owner='o';$slots=4;$appRamGb=24;$witnessFile='w';$pinsDest='p';")
def render(path):
    t = path.read_text()
    m = re.search(r'@"\n(@echo off\nrem The Enclave host node\. Written by install-host\.ps1.*?)\n"@ \| Set-Content -Encoding ASCII \(Join-Path \$PD "node-config\.cmd"\)', t, re.S)
    assert m, "generator block not found"
    code = VARS + '$s=@"\n' + m.group(1) + '\n"@;[Console]::Out.Write($s)'
    return subprocess.run([PWSH, "-NoProfile", "-Command", code], capture_output=True, text=True, check=True).stdout
def category(text):   # postflight.py ENV (A1): the LAST assignment wins
    v = [m.group(1).strip() for l in text.splitlines() if (m := re.match(r'^\s*set\s+"?ENCLAVE_PLATFORM_HOST_POLICY=([^"]*)"?\s*$', l))]
    if not v: return "unset"
    v = v[-1]; return "production" if v == "production" else "off" if v == "off" else "json" if v.startswith("{") else "empty" if v == "" else "other"
class InstallerFix(unittest.TestCase):
    def test_old_generator_leaves_the_gate_off(self):
        self.assertEqual(category(render(OLD)), "unset")
    def test_new_generator_ships_production_before_the_local_override(self):
        r = render(NEW); self.assertEqual(category(r), "production"); lines = r.splitlines()
        self.assertEqual(sum(1 for l in lines if "ENCLAVE_PLATFORM_HOST_POLICY" in l and l.startswith("set ")), 1)
        i = next(k for k, l in enumerate(lines) if l == "set ENCLAVE_PLATFORM_HOST_POLICY=production"); j = next(k for k, l in enumerate(lines) if "node-config.local.cmd\" call" in l)
        self.assertLess(i, j)            # node-config.local.cmd still comes last (an operator's own RPC/mirror settings, or an explicit choice)
    def test_only_the_three_lines_differ_and_it_parses(self):
        o, n = OLD.read_text().splitlines(), NEW.read_text().splitlines(); self.assertEqual(len(n) - len(o), 3)
        self.assertEqual([l for l in n if l not in o], [n[k] for k in range(len(n)) if n[k] not in o][:3])
        out = subprocess.run([PWSH, "-NoProfile", "-Command", f"$t=$null;$e=$null;$null=[Management.Automation.Language.Parser]::ParseFile('{NEW}',[ref]$t,[ref]$e);$e.Count"], capture_output=True, text=True).stdout.strip()
        self.assertEqual(out, "0")
if __name__ == "__main__": unittest.main()

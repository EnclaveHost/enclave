#!/usr/bin/env python3
"""test_installer_fix.py - the platform-carrier installer test (platform-activation/tools/test_installer_fix.py 6576b4a6), RE-POINTED at
the MERGED installer src/install-host.r6p.ps1 (r6 ed729c84 + 4760aae5). Same render (the installer's exact node-config.cmd here-string
rendered by pwsh with dummy inputs) and the same postflight A1 rule (the LAST ENCLAVE_PLATFORM_HOST_POLICY assignment wins).
NEGATIVE CONTROLS: the frozen base 0dc5a801 AND r6 ed729c84 both render 'unset' (= OFF on the Windows node: host.mjs passes book:null).
LOCAL ONLY (pwsh 7 on Linux), NOT native Windows PowerShell 5.1."""
import difflib, os, pathlib, re, subprocess, unittest
A = pathlib.Path(__file__).resolve().parents[1]
PWSH = os.environ.get("PWSH") or "/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh"
BASE, FIX, R6 = A / "ref/install-host.base-0dc5a801.ps1", A / "ref/install-host.policy-fix-d11d4ff6.ps1", A / "ref/install-host.r6.ps1"
NEW = A / "src/install-host.r6p.ps1"
VARS = ("$Name='nucbox-k11-4';$Referral='';$want=[pscustomobject]@{publicUrl='https://api.enclave.host/t/nucbox-k11-4';relay='https://api.enclave.host';rpcs=@();gateways=@();checkers=@();directories=@()};"
        "$independent=$false;$PD='C:\\ProgramData\\Enclave';$PF='C:\\Program Files\\Enclave';$runtimeId='r';$Owner='o';$slots=4;$appRamGb=24;$witnessFile='w';$pinsDest='p';")
def render(path, independent=False):
    t = path.read_text()
    m = re.search(r'@"\n(@echo off\nrem The Enclave host node\. Written by install-host\.ps1.*?)\n"@ \| Set-Content -Encoding ASCII \(Join-Path \$PD "node-config\.cmd"\)', t, re.S)
    assert m, "generator block not found"
    code = VARS.replace("$independent=$false", "$independent=$" + ("true" if independent else "false")) + '$s=@"\n' + m.group(1) + '\n"@;[Console]::Out.Write($s)'
    return subprocess.run([PWSH, "-NoProfile", "-Command", code], capture_output=True, text=True, check=True).stdout
def category(text):   # postflight.py ENV (A1): the LAST assignment wins
    v = [m.group(1).strip() for l in text.splitlines() if (m := re.match(r'^\s*set\s+"?ENCLAVE_PLATFORM_HOST_POLICY=([^"]*)"?\s*$', l))]
    if not v: return "unset"
    v = v[-1]; return "production" if v == "production" else "off" if v == "off" else "json" if v.startswith("{") else "empty" if v == "" else "other"
def added(old, new):
    o, n = old.read_text().splitlines(), new.read_text().splitlines(); sm = difflib.SequenceMatcher(None, o, n, autojunk=False)
    return [(t, o[i1:i2], n[j1:j2]) for t, i1, i2, j1, j2 in sm.get_opcodes() if t != "equal"]
class InstallerFix(unittest.TestCase):
    def test_old_generators_leave_the_gate_off(self):
        self.assertEqual(category(render(BASE)), "unset")
        self.assertEqual(category(render(R6)), "unset", "r6 alone does not carry the 4760aae5 fix")
    def test_merged_generator_ships_production_before_the_local_override(self):
        for indep in (False, True):
            r = render(NEW, indep); self.assertEqual(category(r), "production"); lines = r.splitlines()
            self.assertEqual(sum(1 for l in lines if "ENCLAVE_PLATFORM_HOST_POLICY" in l and l.startswith("set ")), 1)
            i = next(k for k, l in enumerate(lines) if l == "set ENCLAVE_PLATFORM_HOST_POLICY=production"); j = next(k for k, l in enumerate(lines) if "node-config.local.cmd\" call" in l)
            self.assertLess(i, j); self.assertEqual(j, len(lines) - 1, "node-config.local.cmd is still called last")
    def test_merged_generator_equals_the_fix_generator(self):
        self.assertEqual(render(NEW), render(FIX), "the node-config.cmd text r6p writes is byte-identical to 4760aae5's")
    def test_only_the_same_three_lines_are_added_and_it_parses(self):
        fix, mrg = added(BASE, FIX), added(R6, NEW)
        self.assertEqual(len(fix), 1); self.assertEqual(fix[0][0], "insert"); self.assertEqual(len(fix[0][2]), 3)
        self.assertEqual(mrg, fix, "r6 -> r6p adds exactly the 4760aae5 lines and nothing else")
        out = subprocess.run([PWSH, "-NoProfile", "-Command", f"$t=$null;$e=$null;$null=[Management.Automation.Language.Parser]::ParseFile('{NEW}',[ref]$t,[ref]$e);$e.Count"], capture_output=True, text=True).stdout.strip()
        self.assertEqual(out, "0")
if __name__ == "__main__": unittest.main()

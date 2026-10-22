#!/usr/bin/env python3
"""tools/mutants.py - each mutant removes ONE safeguard from the composed coordinator; the named test must FAIL against it (killed).
  PWSH=<pwsh> python3 tools/mutants.py  -> prints one line per mutant and 'killed k/n'; exit 0 only when every mutant is killed."""
import os, pathlib, subprocess, sys, tempfile
A = pathlib.Path(__file__).resolve().parents[1]; SRC = (A / "helper/node-policy-activation.ps1").read_text()
MUTANTS = [
    ("temp-not-exclusive (r5)", "$fs = [IO.File]::Open($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write); $fs.Close()", "[IO.File]::WriteAllBytes($tmp, [byte[]]@())", "TempSafetyR5.test_existing_name_is_never_truncated_or_deleted"),
    ("gate-verdict-ignored", "if ($gp.verdict -ne 'ADMISSIBLE') {", "if ($false) {", "Activation.test_gate_unknown_refuses_before_anything"),
    ("explicit-refusal-rolled-back-to-OFF", [("if ($pr1) {", "if ($false) {"), ("if ($x.persisted) { Recovery", "if ($false) { Recovery")], None, "Activation.test_explicit_ban_after_start_is_never_rolled_back"),
    ("wallet-hold-not-required", "if (-not (Enforced $c0 $null @($PRM.expectedIds))) {", "if ($false) {", "Activation.test_wallet_not_enforced_refuses"),
    ("ready-and-channel-not-required", "if (-not $nn -or -not $gen) {", "if ($false) {", "Activation.test_gate_never_admits_rolls_back_exactly"),
    ("case-colliding-log-key (the found defect)", [("'[host-policy] this host is not serving', 'this host is NOT serving:',", "'[host-policy] this host is not serving', '[host-policy] this host is NOT serving',"), ("$l['this host is NOT serving:']", "$l['[host-policy] this host is NOT serving']")], None, "Activation.test_flap_once_is_check_not_rollback"),
    ("existing-policy-assignment-overwritten", "$n = PolicyNamed $p; if ($n -ne 0) {", "$n = PolicyNamed $p; if ($false) {", "Activation.test_policy_already_named_refuses"),
    ("persisted-refusal-before-start-ignored", "if ($o.persisted) { $why += \"the node's gate state", "if ($false) { $why += \"the node's gate state", "Activation.test_persisted_refusal_refuses"),
    ("expected-retire-ignored", "[int]$l.retiredExpected -eq 0 -and", "", "Activation.test_expected_retire_is_check"),
]
def main():
    env = dict(os.environ); killed = 0; d = pathlib.Path(tempfile.mkdtemp(prefix="pa-mut-"))
    for name, old, new, test in MUTANTS:
        subs = old if isinstance(old, list) else [(old, new)]; t = SRC
        for o, n in subs:
            if t.count(o) != 1: print(f"MUTANT {name}: anchor not unique ({t.count(o)}): {o[:50]}"); sys.exit(2)
            t = t.replace(o, n)
        p = d / (name.split(" ")[0] + ".ps1"); p.write_text(t)
        r = subprocess.run([sys.executable, str(A / "tools/test_activation.py"), test], env={**env, "MUTANT": str(p)}, capture_output=True, text=True, timeout=600)
        k = r.returncode != 0; killed += k
        print(f"{'KILLED ' if k else 'SURVIVED'} {name}  ({test}: rc {r.returncode})")
    print(f"killed {killed}/{len(MUTANTS)}"); sys.exit(0 if killed == len(MUTANTS) else 1)
if __name__ == "__main__": main()

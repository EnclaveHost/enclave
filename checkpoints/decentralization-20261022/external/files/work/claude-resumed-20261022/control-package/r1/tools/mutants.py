#!/usr/bin/env python3
"""Negative controls: re-create each OLD (0829847e) defect in a copy of the candidate helper; the suite must fail each one."""
import pathlib, shutil, subprocess, sys
P = pathlib.Path(__file__).resolve().parents[1]; src = (P / "helper/root-node-hold.py").read_text()
MUT = {"no-runId": ('"stage": stage, "runId": run, ', '"stage": stage, '),
       "rollback-without-target-read": ('todo = [k for k in keys if st[k] == ("new" if back else "old")]', 'todo = list(keys)'),
       "static-1200-lease-guard": ('elif est < LEASE_NEED:', 'elif est < 1200:')}
rc = 0
for name, (a, b) in MUT.items():
    d = P / "mutants" / name; d.mkdir(parents=True)
    for f in ("node-hold-cutover.ps1", "test_root_node_hold.py"): shutil.copy2(P / "helper" / f, d / f)
    assert src.count(a) == 1, name; (d / "root-node-hold.py").write_text(src.replace(a, b))
    # the mutant lives in mutants/<name>/ (PKG = mutants/, W unchanged): point it at the real package files
    (d / "root-node-hold.py").write_text((d / "root-node-hold.py").read_text().replace("PKG = HERE.parent; W = PKG.parents[1]", "PKG = HERE.parents[1]; W = PKG.parents[1]", 1))
    t = (d / "test_root_node_hold.py").read_text().replace("P = H.parent; W = P.parents[1]", "P = H.parents[1]; W = P.parents[1]", 1); (d / "test_root_node_hold.py").write_text(t)
    r = subprocess.run([sys.executable, "-m", "unittest", "test_root_node_hold"], cwd=d, capture_output=True, text=True)
    failed = [l.split(" (")[0].replace("FAIL: ", "").replace("ERROR: ", "") for l in r.stderr.splitlines() if l.startswith(("FAIL:", "ERROR:"))]
    print(f"{name}: rc={r.returncode} failing={failed}"); rc |= (r.returncode == 0)
sys.exit(rc)

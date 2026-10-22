#!/usr/bin/env python3
"""mutants.py: each mutant = root-node-pair.py with ONE safety line changed, in its own dir; the unchanged tests must FAIL on it."""
import pathlib, shutil, subprocess, sys
HERE = pathlib.Path(__file__).resolve().parent
MUT = {
 "m1-no-o-excl": ('    with open(OUT / name, "x") as fh:', '    with open(OUT / name, "w") as fh:'),
 "m2-no-local-pin": ('    if sha(p) != want: raise SystemExit(f"{what}: {path} is not {want}")', '    pass'),
 "m3-open-stage-acl": ("$ds.SetAccessRuleProtection($true,$false);", ""),
 "m4-no-final-identity-gate": ('    final = mode in ("apply", "rollback")', '    final = False'),
 "m5-retry-after-uncertain-launch": ('    if not attempt(f"attempt-{mode}-{run}.json"', '    if not attempt(f"attempt-{mode}-{run}-{uuid.uuid4().hex[:6]}.json"'),
}
rc = 0
for name, (old, new) in MUT.items():
    d = HERE / "mutants" / name; shutil.rmtree(d, ignore_errors=True); d.mkdir(parents=True)
    src = (HERE / "root-node-pair.py").read_text(); assert src.count(old) == 1, name
    (d / "root-node-pair.py").write_text(src.replace(old, new))
    try: compile((d / "root-node-pair.py").read_text(), name, "exec")
    except SyntaxError as e: print(f"{name}: INVALID MUTANT (does not compile: {e})"); rc = 1; continue
    for f in ("test_root_node_pair.py", "params.apply.example.json", "params.identify.example.json"): shutil.copy(HERE / f, d / f)
    r = subprocess.run([sys.executable, "-m", "unittest", "test_root_node_pair.py"], cwd=d, capture_output=True, text=True, timeout=120)
    tail = [l for l in r.stderr.splitlines() if l.startswith(("FAIL:", "ERROR:"))]
    print(f"{name}: {'KILLED' if r.returncode else 'SURVIVED'} rc={r.returncode} ({len(tail)} failing) {tail[:3]} last={r.stderr.strip().splitlines()[-1:]}")
    if not r.returncode: rc = 1
sys.exit(rc)

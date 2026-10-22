#!/usr/bin/env python3
"""Targeted check (not a campaign): each mutant disables ONE strictness rule of libtest_r2.py in a temp copy; the test
suite must fail on it and pass unmutated."""
import pathlib, shutil, subprocess, sys, tempfile
P = pathlib.Path(__file__).resolve().parent.parent; SRC = (P / "libtest_r2.py").read_text()
M = [("summary counts not cross-checked", '''        if (p, f, ig) != tally: errors.append''', '''        if False: errors.append'''),
     ("header while open silently closes", '''                errors.append(f"line {i}: header for {h.group(1)} while {open_name} is still open (unclosed)")\n                outcomes.setdefault(open_name, []).append("unclosed"); open_name = None''',
      '''                outcomes.setdefault(open_name, []).append("ok"); open_name = None'''),
     ("stray terminal ignored", '''            errors.append(f"line {i}: stray terminal {line!r} outside any open test"); continue''', '''            continue'''),
     ("running N not checked", '''    elif running[0] != len(expected): errors.append''', '''    elif False: errors.append'''),
     ("duplicates accepted", '''        if len(outs) > 1: errors.append''', '''        if False: errors.append''')]
rc = 0
with tempfile.TemporaryDirectory(prefix="parser-r2-mut-") as t:
    d = pathlib.Path(t) / "storage-sdk-regressions"; shutil.copytree(P.parent, d, ignore=shutil.ignore_patterns("runs", "out", "logs", "__pycache__", "harness-src", "reevaluations"))
    run = lambda: subprocess.run([sys.executable, "-B", str(d / "parser-r2" / "tests" / "test_libtest_r2.py")], capture_output=True, text=True, timeout=300).returncode
    for what, old, new in M:
        assert SRC.count(old) == 1, what
        (d / "parser-r2" / "libtest_r2.py").write_text(SRC); base = run()
        (d / "parser-r2" / "libtest_r2.py").write_text(SRC.replace(old, new)); mut = run()
        ok = base == 0 and mut != 0; rc |= not ok
        print(f"{'KILLED' if ok else 'NOT KILLED'}  {what}: unmutated rc={base}, mutant rc={mut}", flush=True)
sys.exit(rc)

#!/usr/bin/env python3
"""Targeted check (not a campaign): each mutant disables ONE new rule in a temp copy; the named tests must fail on it
and pass unmutated."""
import pathlib, shutil, subprocess, sys, tempfile
H = pathlib.Path(__file__).resolve().parent.parent; SRC = (H / "sdk_regression_runner.py").read_text()
M = [("no stop after an uncertain group end", "            if rc not in CERTAIN_GROUP_RC:\n", "            if False:\n", ["Groups.test_uncertain_group_end_stops_scheduling"]),
     ("passed-count/extra tests not required", '''and len(results) == 1 and results[0] == ("ok", len(cases), 0) and set(seen) <= set(cases)''', '''and True''', ["Groups.test_extra_tests_or_inconsistent_summary_are_not_a_pass"]),
     ("zero matched cases accepted", '''    ok = all(v == ["ok"] for v in per.values()) and''', '''    ok = True or''', ["Groups.test_zero_tests_matched_is_not_a_pass"]),
     ("harness exit ignored", '''            harness_ok = bool(hm) and hm.group(2) == "0"''', '''            harness_ok = True''', ["Groups.test_certain_failures_do_not_stop_later_groups"])]
def run(d, tests): return subprocess.run([sys.executable, "-B", str(d / "tests" / "test_sdk_runner.py"), *tests], capture_output=True, text=True, timeout=300).returncode
rc = 0
with tempfile.TemporaryDirectory(prefix="sdkreg-mut-") as t:
    d = pathlib.Path(t) / "pkg"; shutil.copytree(H, d, ignore=shutil.ignore_patterns("runs", "logs", "out", "__pycache__"))
    for what, old, new, tests in M:
        assert SRC.count(old) == 1, what
        (d / "sdk_regression_runner.py").write_text(SRC); base = run(d, tests)
        (d / "sdk_regression_runner.py").write_text(SRC.replace(old, new)); mut = run(d, tests)
        ok = base == 0 and mut != 0; rc |= not ok
        print(f"{'KILLED' if ok else 'NOT KILLED'}  {what}: unmutated rc={base}, mutant rc={mut}", flush=True)
sys.exit(rc)

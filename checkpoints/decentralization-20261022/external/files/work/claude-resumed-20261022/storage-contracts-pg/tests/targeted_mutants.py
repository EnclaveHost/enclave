#!/usr/bin/env python3
"""Targeted check (not a mutation campaign): each mutant re-introduces ONE pre-fix behaviour in a temp copy; the named
tests must fail on it and pass on the unmutated copy."""
import pathlib, shutil, subprocess, sys, tempfile
H = pathlib.Path(__file__).resolve().parent.parent
SRC = (H / "contracts_pg_runner.py").read_text()
M = [("no stop after uncertain exec", "            if rc not in CERTAIN_EXEC_RC:\n", "            if False:\n",
      ["Runs.test_outer_timeout_stops_scheduling", "Runs.test_exec_transport_error_stops_scheduling", "Runs.test_outer_timeout_with_unconfirmed_removal_keeps_scratch"]),
     ("any volume-inspect failure = absent", '''        if GONE_VOLUME.search(r.stderr + r.stdout) and "connect" not in (r.stderr + r.stdout).lower(): return "absent"''', '''        return "absent"''',
      ["Cleanup.test_volume_inspect_error_is_not_absence"]),
     ("substring 'no such' = container gone", '''        if GONE_CONTAINER.search(r.stderr + r.stdout) and "connect" not in (r.stderr + r.stdout).lower(): return "absent", None''',
      '''        if "no such" in (r.stderr + r.stdout).lower(): return "absent", None''', ["Cleanup.test_socket_error_after_rm_is_not_absence"]),
     ("adopted container's volumes not captured", '''                if state == "present": self.record_volumes(info)       # capture its anonymous volumes BEFORE removal''', '''                pass''',
      ["Cleanup.test_adopted_container_volume_captured_and_failed_removal_not_hidden"]),
     ("unrecorded volumes treated as gone", '''            d["volumesGone"] = (not left) and self.volumes_known; d["volumesLeft"] = left''', '''            d["volumesGone"] = (not left); d["volumesLeft"] = left''',
      ["Cleanup.test_vanished_container_with_unrecorded_volumes_is_unconfirmed"])]
def run(d, tests):
    return subprocess.run([sys.executable, "-B", str(d / "tests" / "test_runner.py"), *tests], capture_output=True, text=True, timeout=300).returncode
rc = 0
with tempfile.TemporaryDirectory(prefix="scpg-mut-") as t:
    d = pathlib.Path(t) / "pkg"; shutil.copytree(H, d, ignore=shutil.ignore_patterns("runs", "logs", "__pycache__"))
    for what, old, new, tests in M:
        assert SRC.count(old) == 1, what
        (d / "contracts_pg_runner.py").write_text(SRC); base = run(d, tests)
        (d / "contracts_pg_runner.py").write_text(SRC.replace(old, new)); mut = run(d, tests)
        ok = base == 0 and mut != 0; rc |= not ok
        print(f"{'KILLED' if ok else 'NOT KILLED'}  {what}: unmutated rc={base}, mutant rc={mut}  ({', '.join(tests)})", flush=True)
sys.exit(rc)

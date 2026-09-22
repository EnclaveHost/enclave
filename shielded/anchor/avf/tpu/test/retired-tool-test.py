#!/usr/bin/env python3
"""deployed-kernel-error.py must refuse before it can touch the device or the filesystem.

It was retired with a docstring, which is not a refusal: __main__ still called main(), the runner
invocation ended in a shell `tail` that hid its exit status, and the cleanup meant to run before the
transfer was placed after it. A tool whose buggy path is still reachable is still a tool that can report
a stale result as a fresh measurement.

This runs it with a PATH containing a fake `adb` that fails the test if it is ever invoked.
"""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "deployed-kernel-error.py")


def main():
    bad = 0
    d = tempfile.mkdtemp()
    tripwire = os.path.join(d, "adb-was-called")
    fake = os.path.join(d, "adb")
    with open(fake, "w") as f:
        f.write(f"#!/bin/sh\ntouch {tripwire}\nexit 0\n")
    os.chmod(fake, 0o755)
    env = dict(os.environ, PATH=d + os.pathsep + os.environ.get("PATH", ""), ADB=fake)
    r = subprocess.run([sys.executable, TOOL], capture_output=True, text=True, timeout=120, env=env, cwd=d)

    def ck(what, ok, detail=""):
        nonlocal bad
        print(f"{'ok' if ok else 'FAIL':>6}  {what}{'  -- ' + detail if detail else ''}")
        if not ok:
            bad += 1

    ck("exits non-zero", r.returncode != 0, f"rc={r.returncode}")
    ck("says it is retired", "RETIRED" in (r.stderr + r.stdout))
    ck("never invokes adb", not os.path.exists(tripwire),
       "the tripwire fired" if os.path.exists(tripwire) else "")
    ck("writes no files in its working directory", os.listdir(d) == ["adb"],
       ", ".join(sorted(os.listdir(d))))
    print(f"\n{bad} failure(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())

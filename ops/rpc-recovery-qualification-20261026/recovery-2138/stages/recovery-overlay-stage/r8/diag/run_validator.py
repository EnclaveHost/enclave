#!/usr/bin/env python3
"""recovery-overlay-stage/r8 diag/run_validator.py (prepared by Claude 1707; NOT run by Claude). Standard library only.

The ONLY command the diagnostic exposure runs as overlay_session's --exec (cwd = the session run dir; env RECOVERY_TARGET =
<read-only mount>/data/db/mdbx.dat). It copies the pinned validator wrapper mdbx_check.py (bounded) into the run dir, verifies the
COPY's sha256, and execs it (same process: the session's process-group, PDEATHSIG, RLIMIT_FSIZE and deadline apply) with:
  --chk <pinned mdbx_chk> --chk-sha256 <pin> --db-dir dirname(RECOVERY_TARGET) --timeout T --out <run dir>/mdbx-report.json
mdbx_check.py itself refuses unless the db dir is on an ST_RDONLY mount, the binary is the pinned build/version, and it runs only
`mdbx_chk -v DIR` (read-only, exclusive, full B-tree + key/value traversal). Exit: the wrapper's (0 structurally clean, 2 not clean,
1 refused, 128+N cancelled); this launcher exits 1 when it refuses. overlay_session turns any non-zero into rc 6.

    run_validator.py --check-py P --check-py-sha256 H --chk BIN --chk-sha256 H --timeout SEC --out /ABS/report.json
"""
import argparse, hashlib, os, sys

TIMEOUT_MIN, TIMEOUT_MAX = 60, 84600          # the session's own --exec deadline is at most 86400 s: the wrapper always finishes first


def main():
    ap = argparse.ArgumentParser()
    for k in ("check-py", "check-py-sha256", "chk", "chk-sha256", "out"):
        ap.add_argument(f"--{k}", required=True)
    ap.add_argument("--timeout", type=int, required=True)
    a = ap.parse_args()
    t = os.environ.get("RECOVERY_TARGET", "")
    if not t.startswith("/") or os.path.basename(t) != "mdbx.dat" or os.path.basename(os.path.dirname(t)) != "db":
        print("refused: RECOVERY_TARGET must be an absolute .../db/mdbx.dat", file=sys.stderr); return 1
    if not TIMEOUT_MIN <= a.timeout <= TIMEOUT_MAX or not os.path.isabs(a.out) or os.path.lexists(a.out):
        print(f"refused: timeout must be {TIMEOUT_MIN}..{TIMEOUT_MAX}; --out absolute and new", file=sys.stderr); return 1
    with open(a.check_py, "rb") as f:
        src = f.read(1 << 20)
    if hashlib.sha256(src).hexdigest() != a.check_py_sha256:
        print("refused: the validator wrapper is not the pinned one", file=sys.stderr); return 1
    priv = os.path.join(os.getcwd(), "mdbx_check.py")
    fd = os.open(priv, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o400)
    try:
        os.write(fd, src)
    finally:
        os.close(fd)
    with open(priv, "rb") as f:
        if hashlib.sha256(f.read(1 << 20)).hexdigest() != a.check_py_sha256:
            print("refused: the private wrapper copy is not the pinned one", file=sys.stderr); return 1
    os.execv(sys.executable, [sys.executable, "-I", "-B", priv, "--chk", a.chk, "--chk-sha256", a.chk_sha256,
                              "--db-dir", os.path.dirname(t), "--timeout", str(a.timeout), "--out", a.out])


if __name__ == "__main__":
    sys.exit(main())

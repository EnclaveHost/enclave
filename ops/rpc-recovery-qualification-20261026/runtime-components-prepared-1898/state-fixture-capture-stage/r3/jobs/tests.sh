#!/bin/bash
# state-fixture-capture-stage/r3 PURE unit tests (PREPARED by Claude 1879/1889; NOT run by Claude). Root (small lane):
#   bash jobs/q-exit-status.sh sfc-r3-tests 256 unshare -Urn bash state-fixture-capture-stage/r3/jobs/tests.sh
# tests/test_capture.py ("Ran 18 tests"): last stderr line "OK", stdout EMPTY, no ResourceWarning/skipped/FAIL/ERROR/Traceback. No mount, build, toolchain, network or data; the only spawned processes are the r12 fixture scripts with
# arguments they REFUSE before any write (test 13). They read only the frozen r12 sources. Passing qualifies the pure
# wrapper logic + the r12 argument confinement ONLY - NOT a compiled-fixture run, NOT a fixture receipt.
set -uo pipefail
export PATH=/usr/bin:/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "stage != SHA256SUMS"; exit 9; }
ip -4 route 2>/dev/null | grep -q . && { echo "network route present: run under unshare -Urn"; exit 9; }
O=$S/runs/tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p "$O" || exit 9
(cd "$O" && env -i PATH=$PATH timeout -k 5 600 python3 -I -B -u -W always::ResourceWarning "$S/tests/test_capture.py") \
  > "$O/test_capture.stdout.txt" 2> "$O/test_capture.stderr.txt"; r=$?
python3 -I -B - "$O" "$S" "$r" <<'PY' > "$O/receipt.json"; rc=$?
import hashlib, json, re, sys, pathlib
O, S, r = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
out = (O / "test_capture.stdout.txt").read_text(errors="replace")
err = (O / "test_capture.stderr.txt").read_text(errors="replace")
lines = [l for l in err.splitlines() if l.strip()]
ran = re.findall(r"^Ran (\d+) tests? in ", err, re.M)
bad = [w for w in ("ResourceWarning", "skipped", "FAIL", "ERROR", "Traceback") if w in out or w in err]
checks = {"rc0": r == "0", "ranExactly": ran == ["18"], "lastLineOK": bool(lines) and lines[-1] == "OK", "stdoutEmpty": out == "",
          "noBadMarkers": not bad}
rec = {"format": "state-fixture-capture-test-receipt/r3", "pass": all(checks.values()), "checks": checks, "ran": ran, "rc": int(r),
       "expected": 18, "stageSums": hashlib.sha256((S / "SHA256SUMS").read_bytes()).hexdigest(),
       "scope": "pure wrapper logic only: not a compiled-fixture run, not a fixture receipt"}
print(json.dumps(rec, indent=1, sort_keys=True)); sys.exit(0 if rec["pass"] else 1)
PY
tail -2 "$O/test_capture.stderr.txt"; cat "$O/receipt.json"
echo "## outputs $O"; echo "## sfc-r3-tests rc=$rc"; exit $rc

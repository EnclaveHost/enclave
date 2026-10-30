#!/bin/bash
# state-fixture-capture-stage/r1 PURE unit tests (PREPARED by Claude 1877; NOT run by Claude). Root (small lane):
#   bash jobs/q-exit-status.sh sfc-r1-tests 256 unshare -Urn bash state-fixture-capture-stage/r1/jobs/tests.sh
# tests/test_capture.py ("Ran 12 tests"): last stderr line "OK", stdout EMPTY, no ResourceWarning/skipped/FAIL/ERROR/Traceback. No spawn of
# a fixture script, mount, build, toolchain, network or data: they read only the frozen r11 / acceptance r1 sources and the pinned
# acceptance test receipt. Passing qualifies the pure wrapper logic ONLY - NOT a compiled-fixture run, NOT a fixture receipt.
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
checks = {"rc0": r == "0", "ranExactly": ran == ["12"], "lastLineOK": bool(lines) and lines[-1] == "OK", "stdoutEmpty": out == "",
          "noBadMarkers": not bad}
rec = {"format": "state-fixture-capture-test-receipt/r1", "pass": all(checks.values()), "checks": checks, "ran": ran, "rc": int(r),
       "expected": 12, "stageSums": hashlib.sha256((S / "SHA256SUMS").read_bytes()).hexdigest(),
       "scope": "pure wrapper logic only: not a compiled-fixture run, not a fixture receipt"}
print(json.dumps(rec, indent=1, sort_keys=True)); sys.exit(0 if rec["pass"] else 1)
PY
tail -2 "$O/test_capture.stderr.txt"; cat "$O/receipt.json"
echo "## outputs $O"; echo "## sfc-r1-tests rc=$rc"; exit $rc

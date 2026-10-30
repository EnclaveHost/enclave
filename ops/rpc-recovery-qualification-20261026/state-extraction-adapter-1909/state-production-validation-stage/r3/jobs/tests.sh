#!/bin/bash
# state-production-validation-stage/r3 unit/lifecycle-logic tests (PREPARED by Claude 1890/1900; NOT run by Claude). Root (small lane):
#   bash jobs/q-exit-status.sh spv-r3-tests 256 unshare -Urn bash state-production-validation-stage/r3/jobs/tests.sh
# One suite, tests/test_state.py ("Ran 25 tests"): last stderr line "OK", stdout EMPTY, no ResourceWarning/skipped/FAIL/ERROR/Traceback.
# No mount, view, namespace change, compile, network, cgroup change, helper run, production data, part or backup: the tests read
# this stage's sources and the FROZEN pinned sources/receipts (r6, r10, acceptance r3, r12, capture r3) and write only under a tempfile dir.
# Passing qualifies the runner LOGIC on synthetic inputs only - NOT a production run, NOT a state result. Writes receipt.json.
set -uo pipefail
export PATH=/usr/bin:/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "stage != SHA256SUMS"; exit 9; }
ip -4 route 2>/dev/null | grep -q . && { echo "network route present: run under unshare -Urn"; exit 9; }
O=$S/runs/tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p "$O" || exit 9
(cd "$O" && env -i PATH=$PATH timeout -k 5 600 python3 -I -B -u -W always::ResourceWarning "$S/tests/test_state.py") \
  > "$O/test_state.stdout.txt" 2> "$O/test_state.stderr.txt"; r=$?
python3 -I -B - "$O" "$S" "$r" <<'PY' > "$O/receipt.json"; rc=$?
import hashlib, json, re, sys, pathlib
O, S, r = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
out = (O / "test_state.stdout.txt").read_text(errors="replace")
err = (O / "test_state.stderr.txt").read_text(errors="replace")
lines = [l for l in err.splitlines() if l.strip()]
ran = re.findall(r"^Ran (\d+) tests? in ", err, re.M)
bad = [w for w in ("ResourceWarning", "skipped", "FAIL", "ERROR", "Traceback") if w in out or w in err]
checks = {"rc0": r == "0", "ranExactly": ran == ["25"], "lastLineOK": bool(lines) and lines[-1] == "OK", "stdoutEmpty": out == "",
          "noBadMarkers": not bad}
rec = {"format": "state-production-test-receipt/r3", "pass": all(checks.values()), "checks": checks, "ran": ran, "rc": int(r),
       "expected": 25, "stageSums": hashlib.sha256((S / "SHA256SUMS").read_bytes()).hexdigest(),
       "scope": "runner logic on SYNTHETIC inputs only: no view, mount, helper run or production data; not a production run, not a state result"}
print(json.dumps(rec, indent=1, sort_keys=True)); sys.exit(0 if rec["pass"] else 1)
PY
tail -2 "$O/test_state.stderr.txt"; cat "$O/receipt.json"
echo "## outputs $O"; echo "## spv-r3-tests rc=$rc"; exit $rc

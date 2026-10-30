#!/bin/bash
# state-helper-qualification-stage/r3 PURE unit tests (PREPARED by Claude 1884 from r2 1878; NOT run by Claude). Root (small lane):
#   bash jobs/q-exit-status.sh sq-r3-tests 256 unshare -Urn bash state-helper-qualification-stage/r3/jobs/tests.sh
# One suite, tests/test_acceptance.py ("Ran 46 tests": r2's 46, pins/markers/source test moved to bsro r12): last stderr line "OK", stdout EMPTY, no ResourceWarning/skipped/FAIL/ERROR/Traceback.
# No mount, compile, toolchain, network, production data, part or backup: the tests read only this stage's acceptance.py and the FROZEN
# base-state-readonly-stage/r11 source files (pins/constants). Passing qualifies the PURE predicates/parsers only - NOT the production
# runner, NOT any compiled fixture, NOT any state result. Writes receipt.json (bound to SHA256SUMS).
set -uo pipefail
export PATH=/usr/bin:/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "stage != SHA256SUMS"; exit 9; }
ip -4 route 2>/dev/null | grep -q . && { echo "network route present: run under unshare -Urn"; exit 9; }
O=$S/runs/tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p "$O" || exit 9
(cd "$O" && env -i PATH=$PATH timeout -k 5 600 python3 -I -B -u -W always::ResourceWarning "$S/tests/test_acceptance.py") \
  > "$O/test_acceptance.stdout.txt" 2> "$O/test_acceptance.stderr.txt"; r=$?
python3 -I -B - "$O" "$S" "$r" <<'PY' > "$O/receipt.json"; rc=$?
import hashlib, json, re, sys, pathlib
O, S, r = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
out = (O / "test_acceptance.stdout.txt").read_text(errors="replace")
err = (O / "test_acceptance.stderr.txt").read_text(errors="replace")
lines = [l for l in err.splitlines() if l.strip()]
ran = re.findall(r"^Ran (\d+) tests? in ", err, re.M)
bad = [w for w in ("ResourceWarning", "skipped", "FAIL", "ERROR", "Traceback") if w in out or w in err]
checks = {"rc0": r == "0", "ranExactly": ran == ["46"], "lastLineOK": bool(lines) and lines[-1] == "OK", "stdoutEmpty": out == "",
          "noBadMarkers": not bad}
rec = {"format": "state-acceptance-test-receipt/r3", "pass": all(checks.values()), "checks": checks, "ran": ran, "rc": int(r),
       "expected": 46, "stageSums": hashlib.sha256((S / "SHA256SUMS").read_bytes()).hexdigest(),
       "scope": "pure predicates/parsers only: not the production runner, not a compiled-fixture qualification, not a state result"}
print(json.dumps(rec, indent=1, sort_keys=True)); sys.exit(0 if rec["pass"] else 1)
PY
tail -2 "$O/test_acceptance.stderr.txt"; cat "$O/receipt.json"
echo "## outputs $O"; echo "## sq-r3-tests rc=$rc"; exit $rc

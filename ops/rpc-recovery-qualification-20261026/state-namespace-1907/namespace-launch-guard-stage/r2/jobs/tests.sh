#!/bin/bash
# namespace-launch-guard-stage/r2 unit tests (PREPARED by Claude 1901/1903; NOT run by Claude). MOCKED dispatch: nothing is ever executed. Root:
#   bash jobs/q-exit-status.sh nlg-r2-unit 256 unshare -Urn bash namespace-launch-guard-stage/r2/jobs/tests.sh
# tests/test_guard.py: exactly "Ran 12 tests", last line OK, stdout empty, no ResourceWarning/skipped/FAIL/ERROR/Traceback; receipt.json.
set -uo pipefail
export PATH=/usr/bin:/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "stage != SHA256SUMS"; exit 9; }
O=$S/runs/tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p -m 0700 "$O" || exit 9
(cd "$O" && env -i PATH=$PATH timeout -k 5 600 python3 -I -B -u -W always::ResourceWarning "$S/tests/test_guard.py") > "$O/out.txt" 2> "$O/err.txt"; r=$?
python3 -I -B - "$O" "$S" "$r" <<'PY' > "$O/receipt.json"; rc=$?
import hashlib, json, re, sys, pathlib
O, S, r = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
out, err = (O / "out.txt").read_text(errors="replace"), (O / "err.txt").read_text(errors="replace")
lines = [l for l in err.splitlines() if l.strip()]
ran = re.findall(r"^Ran (\d+) tests? in ", err, re.M)
checks = {"rc0": r == "0", "ranExactly": ran == ["12"], "lastLineOK": bool(lines) and lines[-1] == "OK", "stdoutEmpty": out == "",
          "noBadMarkers": not [w for w in ("ResourceWarning", "skipped", "FAIL", "ERROR", "Traceback") if w in out or w in err]}
rec = {"format": "namespace-launch-guard-test-receipt/r2", "pass": all(checks.values()), "checks": checks, "ran": ran, "rc": int(r),
       "stageSums": hashlib.sha256((S / "SHA256SUMS").read_bytes()).hexdigest(), "scope": "mocked dispatch only"}
print(json.dumps(rec, indent=1, sort_keys=True)); sys.exit(0 if rec["pass"] else 1)
PY
tail -3 "$O/err.txt"; cat "$O/receipt.json"; echo "## outputs $O"; echo "## nlg-r2-unit rc=$rc"; exit $rc

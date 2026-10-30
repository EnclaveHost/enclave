#!/bin/bash
# base-state-readonly-stage/r6 disk-guard tests (PREPARED by Claude 1728; NOT run by Claude). Root (small, before the build):
#   bash jobs/q-exit-status.sh bsro-r6-guard-tests 256 unshare -Urn bash base-state-readonly-stage/r6/jobs/guard-tests.sh
# PASS only if: exactly "Ran 10 tests", last stderr line "OK", stdout EMPTY, no ResourceWarning/skipped/FAIL/ERROR/Traceback.
# Synthetic mountinfo + free-space providers; dummy writers <= 4 MiB under this run dir only. Writes receipt.json (bound to SHA256SUMS).
set -uo pipefail
export PATH=/usr/bin:/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P); N=10
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "stage != SHA256SUMS"; exit 9; }
ip -4 route 2>/dev/null | grep -q . && { echo "network route present: run under unshare -Urn"; exit 9; }
O=$S/runs/guard-tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p "$O/tmp" || exit 9
(cd "$O" && env -i PATH=$PATH TEST_TMP="$O/tmp" timeout -k 5 900 python3 -I -B -u -W always::ResourceWarning "$S/tests/test_disk_guard.py") > "$O/stdout.txt" 2> "$O/stderr.txt"; r=$?
python3 -I -B - "$O" "$r" "$S" "$N" <<'PY' > "$O/receipt.json"; rc=$?
import hashlib, json, re, sys, pathlib
O, r, S, n = pathlib.Path(sys.argv[1]), int(sys.argv[2]), pathlib.Path(sys.argv[3]), sys.argv[4]
out, err = (O / "stdout.txt").read_text(errors="replace"), (O / "stderr.txt").read_text(errors="replace")
lines = [l for l in err.splitlines() if l.strip()]
ran = re.findall(r"^Ran (\d+) tests? in ", err, re.M)
bad = [w for w in ("ResourceWarning", "skipped", "FAIL", "ERROR", "Traceback") if w in out or w in err]
checks = {"rc0": r == 0, "ranExactly": ran == [n], "lastLineOK": bool(lines) and lines[-1] == "OK", "stdoutEmpty": out == "", "noBadMarkers": not bad}
rec = {"format": "bsro-guard-test-receipt/r6", "pass": all(checks.values()), "checks": checks, "ran": ran, "rc": r,
       "stageSums": hashlib.sha256((S / "SHA256SUMS").read_bytes()).hexdigest()}
print(json.dumps(rec, indent=1, sort_keys=True)); sys.exit(0 if rec["pass"] else 1)
PY
tail -3 "$O/stderr.txt"; cat "$O/receipt.json"; rm -rf "$O/tmp"
echo "## outputs $O"; echo "## bsro-r6-guard-tests rc=$rc"; exit $rc

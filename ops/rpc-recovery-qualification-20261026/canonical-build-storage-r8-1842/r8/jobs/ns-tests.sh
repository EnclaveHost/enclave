#!/bin/bash
# base-state-readonly-stage/r8 NAMESPACE tests (PREPARED by Claude 1839; NOT run by Claude). They need a REAL private user+mount namespace
# (no skip-as-pass: outside one they fail):
#   bash jobs/q-exit-status.sh bsro-r8-ns-tests 256 unshare -Urnm bash base-state-readonly-stage/r8/jobs/ns-tests.sh
# tests/test_ns.py ("Ran 4 tests"): exact inside id maps, jobs/ns.sh (private propagation, then a read-only bind of a TEST dir only),
# EROFS on write, the read-only / writable checks, and the outer-map check refusing inside. Every mount is in this namespace only and is
# gone when it exits. Same strict gate as guard-tests; receipt.json (bound to SHA256SUMS).
set -uo pipefail
export PATH=/usr/bin:/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "stage != SHA256SUMS"; exit 9; }
[ "$(awk 'NF' /proc/self/uid_map | wc -l)" = 1 ] && awk '{exit !($1 == 0 && $3 == 1)}' /proc/self/uid_map \
  || { echo "REFUSED: not inside an unshare -Urnm user namespace"; exit 9; }
O=$S/runs/ns-tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p "$O/tmp" || exit 9
(cd "$O" && env -i PATH=$PATH TEST_TMP="$O/tmp" timeout -k 5 300 python3 -I -B -u -W always::ResourceWarning "$S/tests/test_ns.py") > "$O/test_ns.stdout.txt" 2> "$O/test_ns.stderr.txt"
r=$?
python3 -I -B - "$O" "$S" "$r" <<'PY' > "$O/receipt.json"; rc=$?
import hashlib, json, re, sys, pathlib
O, S, r = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
out, err = (O / "test_ns.stdout.txt").read_text(errors="replace"), (O / "test_ns.stderr.txt").read_text(errors="replace")
lines = [l for l in err.splitlines() if l.strip()]
ran = re.findall(r"^Ran (\d+) tests? in ", err, re.M)
bad = [w for w in ("ResourceWarning", "skipped", "FAIL", "ERROR", "Traceback") if w in out or w in err]
checks = {"rc0": r == "0", "ranExactly": ran == ["4"], "lastLineOK": bool(lines) and lines[-1] == "OK", "stdoutEmpty": out == "", "noBadMarkers": not bad}
suite = {"pass": all(checks.values()), "checks": checks, "ran": ran, "rc": int(r), "expected": 4}
rec = {"format": "bsro-ns-test-receipt/r8", "pass": suite["pass"], "suites": {"test_ns": suite},
       "stageSums": hashlib.sha256((S / "SHA256SUMS").read_bytes()).hexdigest()}
print(json.dumps(rec, indent=1, sort_keys=True)); sys.exit(0 if rec["pass"] else 1)
PY
tail -2 "$O"/test_ns.stderr.txt; cat "$O/receipt.json"; rm -rf "$O/tmp"
echo "## outputs $O"; echo "## bsro-r8-ns-tests rc=$rc"; exit $rc

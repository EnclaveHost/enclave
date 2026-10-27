#!/bin/bash
# base-state-readonly-stage/r9 NAMESPACE tests (PREPARED by Claude 1839; NOT run by Claude). They need a REAL private user+mount namespace
# (no skip-as-pass: outside one they fail):
#   bash jobs/q-exit-status.sh bsro-r9-ns-tests 256 unshare -Urnm bash base-state-readonly-stage/r9/jobs/ns-tests.sh
# tests/test_ns.py ("Ran 5 tests"): exact inside id maps, jobs/ns.sh on TEST dirs (private propagation, then a recursive read-only bind),
# EROFS on write, the read-only / writable checks, the outer-map check refusing inside, and (r9, review 1841 PB1) the PRODUCTION
# `ns_harden /home/steven /tmp` + `bsro_gate.py ns-check` in a NESTED private mount namespace child (inherited locked submounts, tmpfs).
# Every mount is in these namespaces only and is gone when they exit; this job's own outputs under /home/steven stay writable. Same strict gate as guard-tests; receipt.json (bound to SHA256SUMS).
set -uo pipefail
export PATH=/usr/bin:/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "stage != SHA256SUMS"; exit 9; }
[ "$(awk 'NF' /proc/self/uid_map | wc -l)" = 1 ] && awk '{exit !($1 == 0 && $3 == 1)}' /proc/self/uid_map \
  || { echo "REFUSED: not inside an unshare -Urnm user namespace"; exit 9; }
# r9: never hold clones of a LIVE recovery/composite FUSE session (a mount namespace pins every mount it copied until it exits, which
# could delay that session's teardown): refuse at once while any stage mount exists (a refusal, never a pass)
if grep -qE '/recovery-multipart-stage/|/recovery-overlay-stage/|/composite-mdbx-validation-stage/|/composite-memory-fixture-stage/' /proc/self/mountinfo; then
  echo "REFUSED: a recovery/composite stage mount exists: run the namespace tests when no session is active"; exit 9; fi
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
checks = {"rc0": r == "0", "ranExactly": ran == ["5"], "lastLineOK": bool(lines) and lines[-1] == "OK", "stdoutEmpty": out == "", "noBadMarkers": not bad}
suite = {"pass": all(checks.values()), "checks": checks, "ran": ran, "rc": int(r), "expected": 5}
rec = {"format": "bsro-ns-test-receipt/r9", "pass": suite["pass"], "suites": {"test_ns": suite},
       "stageSums": hashlib.sha256((S / "SHA256SUMS").read_bytes()).hexdigest()}
print(json.dumps(rec, indent=1, sort_keys=True)); sys.exit(0 if rec["pass"] else 1)
PY
tail -2 "$O"/test_ns.stderr.txt; cat "$O/receipt.json"; rm -rf "$O/tmp"
echo "## outputs $O"; echo "## bsro-r9-ns-tests rc=$rc"; exit $rc

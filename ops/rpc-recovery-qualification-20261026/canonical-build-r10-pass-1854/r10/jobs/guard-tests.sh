#!/bin/bash
# base-state-readonly-stage/r10 guard + unit tests (PREPARED by Claude 1728/1735/1839; NOT run by Claude). Root (small, before any build):
#   bash jobs/q-exit-status.sh bsro-r10-guard-tests 256 unshare -Urn bash base-state-readonly-stage/r10/jobs/guard-tests.sh
# Three suites, each must PASS exactly: tests/test_disk_guard.py (byte-identical to r5/r7: "Ran 10 tests"), tests/test_mount_identity.py
# (= r7: "Ran 6 tests") and r10's tests/test_bsro_gate.py ("Ran 16 tests"): last stderr line "OK", stdout EMPTY, no ResourceWarning/skipped/
# FAIL/ERROR/Traceback. No compilation, mount, part read or production state (test 11 runs only `rustc -V`/`cargo -V` in a tmp run dir).
# The namespace tests are SEPARATE (jobs/ns-tests.sh). Writes receipt.json (bound to SHA256SUMS).
set -uo pipefail
export PATH=/usr/bin:/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "stage != SHA256SUMS"; exit 9; }
ip -4 route 2>/dev/null | grep -q . && { echo "network route present: run under unshare -Urn"; exit 9; }
O=$S/runs/guard-tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p "$O/tmp" || exit 9
rs=()
for t in "test_disk_guard 10" "test_mount_identity 6" "test_bsro_gate 16"; do set -- $t
  (cd "$O" && env -i PATH=$PATH TEST_TMP="$O/tmp" timeout -k 5 900 python3 -I -B -u -W always::ResourceWarning "$S/tests/$1.py") > "$O/$1.stdout.txt" 2> "$O/$1.stderr.txt"
  rs+=("$1:$2:$?")
done
python3 -I -B - "$O" "$S" "${rs[@]}" <<'PY' > "$O/receipt.json"; rc=$?
import hashlib, json, re, sys, pathlib
O, S = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
suites = {}
for spec in sys.argv[3:]:
    name, n, r = spec.split(":")
    out, err = (O / f"{name}.stdout.txt").read_text(errors="replace"), (O / f"{name}.stderr.txt").read_text(errors="replace")
    lines = [l for l in err.splitlines() if l.strip()]
    ran = re.findall(r"^Ran (\d+) tests? in ", err, re.M)
    bad = [w for w in ("ResourceWarning", "skipped", "FAIL", "ERROR", "Traceback") if w in out or w in err]
    checks = {"rc0": r == "0", "ranExactly": ran == [n], "lastLineOK": bool(lines) and lines[-1] == "OK", "stdoutEmpty": out == "", "noBadMarkers": not bad}
    suites[name] = {"pass": all(checks.values()), "checks": checks, "ran": ran, "rc": int(r), "expected": int(n)}
rec = {"format": "bsro-guard-test-receipt/r10", "pass": len(suites) == 3 and all(s["pass"] for s in suites.values()), "suites": suites,
       "stageSums": hashlib.sha256((S / "SHA256SUMS").read_bytes()).hexdigest()}
print(json.dumps(rec, indent=1, sort_keys=True)); sys.exit(0 if rec["pass"] else 1)
PY
tail -2 "$O"/*.stderr.txt; cat "$O/receipt.json"; rm -rf "$O/tmp"
echo "## outputs $O"; echo "## bsro-r10-guard-tests rc=$rc"; exit $rc

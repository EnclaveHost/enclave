#!/bin/bash
# recovery-multipart-stage/r2 UNIT tests (PREPARED by Claude 1748; NOT run by Claude). Root, via the shared queue:
#   bash jobs/q-exit-status.sh rmp-r2-tests 512 unshare -Urn bash recovery-multipart-stage/r2/jobs/tests.sh
# Unprivileged owner only (real root refused). Tiny fixtures under this run dir ($MULTIPART_TEST_TMP; TEST_TMP/TMPDIR/HOME untouched);
# no production input, original, overlay, journal copy, device, VM or USB. No network.
# PASS only if: exactly "Ran 26 tests", last stderr line "OK", stdout EMPTY, no ResourceWarning/skipped/FAIL/ERROR/Traceback, rc 0.
# Receipt bound to SHA256SUMS + multipart.py + orchestrate.py + the test file. Bounds: 900 s wall, 600 s CPU.
set -uo pipefail
export PATH=/usr/bin:/bin
read -r _in outer _n < /proc/self/uid_map
[ "$outer" != 0 ] || { echo "REFUSED: run as the unprivileged owner under unshare -Urn, never as real root"; exit 9; }
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P); N=26
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "stage != SHA256SUMS"; exit 9; }
ip -4 route 2>/dev/null | grep -q . && { echo "network route present: run under unshare -Urn"; exit 9; }
[ -z "$(find "$S" -path "$S/runs" -prune -o \( -name __pycache__ -o -name '*.pyc' \) -print)" ] || { echo "bytecode in stage"; exit 9; }
O=$S/runs/tests-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p "$S/runs" && mkdir -m 0700 "$O" && mkdir -m 0700 "$O/tmp" || { echo "run dir exists or cannot be created"; exit 9; }
(cd "$O" && ulimit -t 600 && env -i PATH=$PATH MULTIPART_TEST_TMP="$O/tmp" timeout -k 5 900 python3 -I -B -u -W always::ResourceWarning "$S/tests/test_multipart.py") > "$O/stdout.txt" 2> "$O/stderr.txt"; r=$?
python3 -I -B - "$O" "$r" "$S" "$N" <<'PY' > "$O/receipt.json"; rc=$?
import hashlib, json, re, sys, pathlib
O, r, S, n = pathlib.Path(sys.argv[1]), int(sys.argv[2]), pathlib.Path(sys.argv[3]), sys.argv[4]
out, err = (O / "stdout.txt").read_text(errors="replace"), (O / "stderr.txt").read_text(errors="replace")
lines = [l for l in err.splitlines() if l.strip()]
ran = re.findall(r"^Ran (\d+) tests? in ", err, re.M)
bad = [w for w in ("ResourceWarning", "skipped", "FAIL", "ERROR", "Traceback") if w in out or w in err]
checks = {"rc0": r == 0, "ranExactly": ran == [n], "lastLineOK": bool(lines) and lines[-1] == "OK", "stdoutEmpty": out == "", "noBadMarkers": not bad}
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
rec = {"format": "recovery-multipart-test-receipt/r2", "suite": "unit", "pass": all(checks.values()), "checks": checks, "expectedTests": int(n),
       "ran": ran, "rc": r, "badMarkers": bad, "stageSums": sha(S / "SHA256SUMS"), "multipartSha256": sha(S / "multipart.py"),
       "orchestrateSha256": sha(S / "orchestrate.py"), "testsSha256": sha(S / "tests" / "test_multipart.py")}
print(json.dumps(rec, indent=1, sort_keys=True)); sys.exit(0 if rec["pass"] else 1)
PY
tail -3 "$O/stderr.txt"; cat "$O/receipt.json"; rm -rf "$O/tmp"
[ $rc = 0 ] && echo "## PASS ($N)" || echo "## FAIL"
echo "## receipt $O/receipt.json"; echo "## rmp-r2-tests rc=$rc"; exit $rc

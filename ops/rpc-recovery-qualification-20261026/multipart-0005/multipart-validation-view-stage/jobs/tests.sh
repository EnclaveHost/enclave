#!/bin/bash
# multipart-validation-view-stage/r3 FIXTURE tests (PREPARED by Claude 1751; NOT run by Claude). Root, via the shared queue:
#   bash jobs/q-exit-status.sh mvv-r3-tests 256 unshare -Urn bash multipart-validation-view-stage/r3/jobs/tests.sh
# Unprivileged owner only (real root refused). Tiny fixture parts under this run dir ($MVV_TEST_TMP; TMPDIR/HOME untouched); the
# pinned qemu-io / qemu-img / qemu-nbd 11.1.2 only. No production input, original, MDBX file, device, VM, USB or network.
# PASS only if: exactly "Ran 5 tests", last stderr line "OK", stdout EMPTY, no ResourceWarning/skipped/FAIL/ERROR/Traceback, rc 0.
# The run dir and receipt are RETAINED (only the fixture tmp is removed). Bounds: 600 s wall, 300 s CPU.
set -uo pipefail
export PATH=/usr/bin:/bin:/usr/sbin
read -r _in outer _n < /proc/self/uid_map
[ "$outer" != 0 ] || { echo "REFUSED: run as the unprivileged owner under unshare -Urn, never as real root"; exit 9; }
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P); N=5
[ "$S" = /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/multipart-validation-view-stage/r3 ] || { echo "unexpected stage path"; exit 9; }
source "$S/jobs/pins.sh"; pins_ok || exit 9
ip -4 route 2>/dev/null | grep -q . && { echo "network route present: run under unshare -Urn"; exit 9; }
O=$S/runs/tests-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p "$S/runs" && mkdir -m 0700 "$O" && mkdir -m 0700 "$O/tmp" || { echo "run dir exists or cannot be created"; exit 9; }
(cd "$O" && ulimit -t 300 && env -i PATH=$PATH MVV_TEST_TMP="$O/tmp" timeout -k 5 600 python3 -I -B -u -W always::ResourceWarning "$S/tests/test_view_descriptor.py") > "$O/stdout.txt" 2> "$O/stderr.txt"; r=$?
python3 -I -B - "$O" "$r" "$S" "$N" <<'PY' > "$O/receipt.json"; rc=$?
import hashlib, json, re, sys, pathlib
O, r, S, n = pathlib.Path(sys.argv[1]), int(sys.argv[2]), pathlib.Path(sys.argv[3]), sys.argv[4]
out, err = (O / "stdout.txt").read_text(errors="replace"), (O / "stderr.txt").read_text(errors="replace")
lines = [l for l in err.splitlines() if l.strip()]
ran = re.findall(r"^Ran (\d+) tests? in ", err, re.M)
bad = [w for w in ("ResourceWarning", "skipped", "FAIL", "ERROR", "Traceback") if w in out or w in err]
checks = {"rc0": r == 0, "ranExactly": ran == [n], "lastLineOK": bool(lines) and lines[-1] == "OK", "stdoutEmpty": out == "", "noBadMarkers": not bad}
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
rec = {"format": "multipart-validation-view-test-receipt/r1", "suite": "fixture", "pass": all(checks.values()), "checks": checks,
       "expectedTests": int(n), "ran": ran, "rc": r, "badMarkers": bad, "stageSums": sha(S / "SHA256SUMS"),
       "viewDescriptorSha256": sha(S / "view_descriptor.py"), "testsSha256": sha(S / "tests" / "test_view_descriptor.py"),
       "scope": "tiny fixture parts only; no MDBX file, no production parts, no integrity claim"}
print(json.dumps(rec, indent=1, sort_keys=True)); sys.exit(0 if rec["pass"] else 1)
PY
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; rc=1; }
tail -3 "$O/stderr.txt"; cat "$O/receipt.json"; rm -rf "$O/tmp"
[ $rc = 0 ] && echo "## PASS ($N)" || echo "## FAIL"
echo "## receipt $O/receipt.json"; echo "## mvv-r3-tests rc=$rc"; exit $rc

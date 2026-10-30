#!/bin/bash
# composite-mdbx-validation-stage/r9 UNIT tests (PREPARED by Claude 1825/1829; NOT run by Claude). Tiny: no FUSE, mount, qemu, MDBX, view or
# scope change. Shared queue (root ran r8's 10 actual tests on the 256 MiB small lane; r9 adds 5 tiny tests):
#   bash jobs/q-exit-status.sh cmv-r9-tests 256 bash composite-mdbx-validation-stage/r9/jobs/tests.sh
# PASS only if: exactly "Ran 15 tests", last stderr line "OK", stdout EMPTY, no ResourceWarning/skipped/FAIL/ERROR/Traceback, rc 0, the
# stage unchanged. The run dir and receipt are RETAINED; the tmp is removed only after a PASS.
set -uo pipefail
export PATH=/usr/bin:/bin LC_ALL=C
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/composite-mdbx-validation-stage/r9
die() { echo "## REFUSED: $*"; exit 9; }
[ "$(id -u)" != 0 ] || die "run as the owner, never as root"
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "stage != SHA256SUMS"
[ -z "$(find $S -path $S/runs -prune -o \( -name __pycache__ -o -name '*.pyc' \) -print)" ] || die "bytecode in the stage"
O=$S/runs/tests-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p "$S/runs" && chmod 0700 "$S/runs" && mkdir -m 0700 "$O" && mkdir -m 0700 "$O/tmp" || die "run dir"
(cd $O && env -i PATH=$PATH LC_ALL=C R8_TEST_TMP=$O/tmp timeout -k 10 900 \
  python3 -I -B -u -W always::ResourceWarning $S/tests/test_memory_gate.py) > $O/stdout.txt 2> $O/stderr.txt; echo $? > $O/rc
python3 -I -B - "$O" "$S" <<'PY' > $O/receipt.json; rc=$?
import hashlib, json, re, sys, pathlib
O, S = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out, err, r = (O / "stdout.txt").read_text(errors="replace"), (O / "stderr.txt").read_text(errors="replace"), int((O / "rc").read_text())
lines = [l for l in err.splitlines() if l.strip()]
ran = re.findall(r"^Ran (\d+) tests? in ", err, re.M)
bad = [w for w in ("ResourceWarning", "skipped", "FAIL", "ERROR", "Traceback") if w in out or w in err]
checks = {"rc0": r == 0, "ranExactly": ran == ["15"], "lastLineOK": bool(lines) and lines[-1] == "OK", "stdoutEmpty": out == "", "noBadMarkers": not bad}
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
rec = {"format": "composite-production-memory-gate-test-receipt/r9", "pass": all(checks.values()), "checks": checks, "expectedTests": 15, "ran": ran,
       "rc": r, "badMarkers": bad, "stageSums": sha(S / "SHA256SUMS"), "gateSha256": sha(S / "memory_gate.py"),
       "testsSha256": sha(S / "tests" / "test_memory_gate.py"), "scope": "gate/runtime unit tests only; no mount, no scope change, no production"}
print(json.dumps(rec, indent=1, sort_keys=True)); sys.exit(0 if rec["pass"] else 1)
PY
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; rc=1; }
tail -3 $O/stderr.txt; cat $O/receipt.json
[ $rc = 0 ] && rm -rf $O/tmp || echo "## tmp RETAINED: $O/tmp"
[ $rc = 0 ] && echo "## PASS (15)" || echo "## FAIL"
echo "## receipt $O/receipt.json"; echo "## cmv-r9-tests rc=$rc"; exit $rc

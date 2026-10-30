#!/bin/bash
# composite-memory-fixture-stage/r3 UNIT tests (PREPARED by Claude 1810/1813; NOT run by Claude). Tiny: no FUSE, mount, qemu, scope change.
#   bash jobs/q-exit-status.sh cmf-r3-tests 512 bash composite-memory-fixture-stage/r3/jobs/tests.sh
# PASS only if: exactly "Ran 11 tests", last stderr line "OK", stdout EMPTY, no ResourceWarning/skipped/FAIL/ERROR/Traceback, rc 0, stage
# unchanged. The run dir and receipt are RETAINED; the tmp is removed only after a PASS.
set -uo pipefail
source /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/composite-memory-fixture-stage/r3/jobs/common.sh
mguards
O=$M/runs/tests-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p "$M/runs" && chmod 0700 "$M/runs" && mkdir -m 0700 "$O" && mkdir -m 0700 "$O/tmp" || mdie "run dir"
(cd $O && env -i PATH=$PATH LC_ALL=C CMF_TEST_TMP=$O/tmp timeout -k 10 600 \
  python3 -I -B -u -W always::ResourceWarning $M/tests/test_memory_fixture.py) > $O/stdout.txt 2> $O/stderr.txt; echo $? > $O/rc
python3 -I -B - "$O" "$M" <<'PY' > $O/receipt.json; rc=$?
import hashlib, json, re, sys, pathlib
O, S = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out, err, r = (O / "stdout.txt").read_text(errors="replace"), (O / "stderr.txt").read_text(errors="replace"), int((O / "rc").read_text())
lines = [l for l in err.splitlines() if l.strip()]
ran = re.findall(r"^Ran (\d+) tests? in ", err, re.M)
bad = [w for w in ("ResourceWarning", "skipped", "FAIL", "ERROR", "Traceback") if w in out or w in err]
checks = {"rc0": r == 0, "ranExactly": ran == ["11"], "lastLineOK": bool(lines) and lines[-1] == "OK", "stdoutEmpty": out == "", "noBadMarkers": not bad}
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
rec = {"format": "composite-memory-fixture-test-receipt/r2", "pass": all(checks.values()), "checks": checks, "expectedTests": 11, "ran": ran,
       "rc": r, "badMarkers": bad, "stageSums": sha(S / "SHA256SUMS"), "fixtureSha256": sha(S / "memory_fixture.py"),
       "testsSha256": sha(S / "tests" / "test_memory_fixture.py"), "scope": "unit tests only; no mount, no scope change, no measurement"}
print(json.dumps(rec, indent=1, sort_keys=True)); sys.exit(0 if rec["pass"] else 1)
PY
(cd $M && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; rc=1; }
tail -3 $O/stderr.txt; cat $O/receipt.json
[ $rc = 0 ] && rm -rf $O/tmp || echo "## tmp RETAINED: $O/tmp"
[ $rc = 0 ] && echo "## PASS (11)" || echo "## FAIL"
echo "## receipt $O/receipt.json"; echo "## cmf-r3-tests rc=$rc"; exit $rc

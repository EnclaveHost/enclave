#!/bin/bash
# composite-mdbx-validation-stage/r3 FIXTURE tests (PREPARED by Claude 1782; NOT run by Claude). Root, at a batch boundary (FUSE +
# qemu-nbd children; tiny files only; no production view, part, original, device, VM or network):
#   bash jobs/q-exit-status.sh cmv-r3-tests 512 bash composite-mdbx-validation-stage/r3/jobs/tests.sh
# Unprivileged owner, NOT under unshare (the FUSE mounts need the host fusermount3). PASS only if: exactly "Ran 12 tests", last stderr
# line "OK", stdout EMPTY, no ResourceWarning/skipped/FAIL/ERROR/Traceback, rc 0, peers' mounts/processes identical before/after, no
# mount left under the run dir, the stage + pinned stages unchanged. The run dir and receipt are RETAINED; the fixture tmp is removed
# ONLY after a PASS with no mount left - any failure keeps every fixture, run dir and receipt as evidence (r2).
# Exclusive by the queue: >= 512 MiB jobs share one exclusive main flock (no overlap with 1024 MiB preservation sessions).
set -uo pipefail
source /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/composite-mdbx-validation-stage/r3/jobs/common.sh
guards
O=$S/runs/tests-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p "$S/runs" && chmod 0700 "$S/runs" && mkdir -m 0700 "$O" && mkdir -m 0700 "$O/tmp" || die "run dir"
peer_snapshot > $O/peers-before.txt
(cd $O && env -i PATH=$PATH LC_ALL=C COMPOSITE_TEST_TMP=$O/tmp MDBX_BIN=$MDBX_BIN timeout -k 10 3600 \
  python3 -I -B -u -W always::ResourceWarning $S/tests/test_composite_session.py) > $O/stdout.txt 2> $O/stderr.txt; echo $? > $O/rc
peer_snapshot > $O/peers-after.txt
grep -F "$O" /proc/self/mountinfo > $O/mounts-left.txt
python3 -I -B - "$O" "$S" <<'PY' > $O/receipt.json; rc=$?
import hashlib, json, re, sys, pathlib
O, S = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
out, err, r = (O / "stdout.txt").read_text(errors="replace"), (O / "stderr.txt").read_text(errors="replace"), int((O / "rc").read_text())
lines = [l for l in err.splitlines() if l.strip()]
ran = re.findall(r"^Ran (\d+) tests? in ", err, re.M)
bad = [w for w in ("ResourceWarning", "skipped", "FAIL", "ERROR", "Traceback") if w in out or w in err]
checks = {"rc0": r == 0, "ranExactly": ran == ["12"], "lastLineOK": bool(lines) and lines[-1] == "OK", "stdoutEmpty": out == "",
          "noBadMarkers": not bad, "peersUnchanged": (O / "peers-before.txt").read_text() == (O / "peers-after.txt").read_text(),
          "noMountLeft": (O / "mounts-left.txt").read_text() == ""}
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
rec = {"format": "composite-mdbx-validation-test-receipt/r3", "pass": all(checks.values()), "checks": checks, "expectedTests": 12, "ran": ran,
       "rc": r, "badMarkers": bad, "stageSums": sha(S / "SHA256SUMS"), "sessionSha256": sha(S / "composite_session.py"),
       "testsSha256": sha(S / "tests" / "test_composite_session.py"),
       "scope": "tiny real MDBX fixtures only; no production view or part; not chain/state/RPC/SNP validation"}
print(json.dumps(rec, indent=1, sort_keys=True)); sys.exit(0 if rec["pass"] else 1)
PY
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; rc=1; }
tail -3 $O/stderr.txt; cat $O/receipt.json
if [ $rc = 0 ] && ! grep -qF "$O" /proc/self/mountinfo; then rm -rf $O/tmp; else echo "## fixtures RETAINED for inspection: $O/tmp (never removed after a failure or with a mount)"; fi
[ $rc = 0 ] && echo "## PASS (12)" || echo "## FAIL"
echo "## receipt $O/receipt.json"; echo "## cmv-r3-tests rc=$rc"; exit $rc

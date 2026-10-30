#!/bin/bash
# composite-mdbx-validation-stage/r5 FIXTURE tests (PREPARED by Claude 1782/1785/1787/1792; NOT run by Claude). Root, main lane:
#   bash jobs/q-exit-status.sh cmv-r5-tests 512 bash composite-mdbx-validation-stage/r5/jobs/tests.sh
# Exclusive by the queue: every >= 512 MiB job holds the same exclusive main flock (no overlap with the 1024 MiB preservation jobs).
# Admission (jobs/common.sh guards): real live session processes (jobs/session_guard.py, PID/argv logged) or a stage mount refuse.
# Two suites, each its own process: test_session_guard (4; no FUSE) then test_composite_session (12; FUSE + qemu-nbd; = r4's).
# Unprivileged owner, NOT under unshare (the FUSE mounts need the host fusermount3). PASS only if BOTH: exactly "Ran 4" / "Ran 12",
# last stderr line "OK", stdout EMPTY, no ResourceWarning/skipped/FAIL/ERROR/Traceback, rc 0; peers' mounts/processes identical before
# and after; no mount left under the run dir; the stage + pinned stages unchanged. The run dir and receipt are RETAINED; the fixture
# tmp is removed ONLY after a PASS with no mount left (any failure keeps every fixture, run dir and receipt as evidence).
set -uo pipefail
source /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/composite-mdbx-validation-stage/r5/jobs/common.sh
guards
O=$S/runs/tests-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p "$S/runs" && chmod 0700 "$S/runs" && mkdir -m 0700 "$O" && mkdir -m 0700 "$O/tmp" || die "run dir"
peer_snapshot > $O/peers-before.txt
for t in test_session_guard test_composite_session; do
  (cd $O && env -i PATH=$PATH LC_ALL=C COMPOSITE_TEST_TMP=$O/tmp MDBX_BIN=$MDBX_BIN timeout -k 10 3600 \
    python3 -I -B -u -W always::ResourceWarning $S/tests/$t.py) > $O/$t.stdout.txt 2> $O/$t.stderr.txt; echo $? > $O/$t.rc
done
peer_snapshot > $O/peers-after.txt
grep -F "$O" /proc/self/mountinfo > $O/mounts-left.txt
python3 -I -B - "$O" "$S" <<'PY' > $O/receipt.json; rc=$?
import hashlib, json, re, sys, pathlib
O, S = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
suites = {}
for t, n in (("test_session_guard", "4"), ("test_composite_session", "12")):
    out, err = (O / f"{t}.stdout.txt").read_text(errors="replace"), (O / f"{t}.stderr.txt").read_text(errors="replace")
    r = int((O / f"{t}.rc").read_text())
    lines = [l for l in err.splitlines() if l.strip()]
    ran = re.findall(r"^Ran (\d+) tests? in ", err, re.M)
    bad = [w for w in ("ResourceWarning", "skipped", "FAIL", "ERROR", "Traceback") if w in out or w in err]
    checks = {"rc0": r == 0, "ranExactly": ran == [n], "lastLineOK": bool(lines) and lines[-1] == "OK", "stdoutEmpty": out == "", "noBadMarkers": not bad}
    suites[t] = {"pass": all(checks.values()), "checks": checks, "expectedTests": int(n), "ran": ran, "rc": r, "badMarkers": bad,
                 "testsSha256": sha(S / "tests" / f"{t}.py")}
env = {"peersUnchanged": (O / "peers-before.txt").read_text() == (O / "peers-after.txt").read_text(),
       "noMountLeft": (O / "mounts-left.txt").read_text() == ""}
rec = {"format": "composite-mdbx-validation-test-receipt/r5", "pass": all(s["pass"] for s in suites.values()) and all(env.values()),
       "suites": suites, "environment": env, "stageSums": sha(S / "SHA256SUMS"), "sessionSha256": sha(S / "composite_session.py"),
       "guardSha256": sha(S / "jobs" / "session_guard.py"),
       "scope": "tiny real MDBX fixtures + guard unit tests only; no production view or part; not chain/state/RPC/SNP validation"}
print(json.dumps(rec, indent=1, sort_keys=True)); sys.exit(0 if rec["pass"] else 1)
PY
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; rc=1; }
for t in test_session_guard test_composite_session; do tail -3 $O/$t.stderr.txt; done; cat $O/receipt.json
if [ $rc = 0 ] && ! grep -qF "$O" /proc/self/mountinfo; then rm -rf $O/tmp; else echo "## fixtures RETAINED for inspection: $O/tmp (never removed after a failure or with a mount)"; fi
[ $rc = 0 ] && echo "## PASS (4+12)" || echo "## FAIL"
echo "## receipt $O/receipt.json"; echo "## cmv-r5-tests rc=$rc"; exit $rc

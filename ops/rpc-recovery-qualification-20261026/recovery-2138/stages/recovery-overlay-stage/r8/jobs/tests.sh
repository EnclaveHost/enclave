#!/bin/bash
# recovery-overlay-stage/r8 FIXTURE tests (prepared by Claude 1660/1674/1707; NOT run by Claude). Unprivileged and NOT under unshare (the
# FUSE mounts need the host fusermount3); only unix sockets in the run dir; nothing outside $O is written. Root:
#   bash jobs/q-exit-status.sh rov-r8-tests 512 bash recovery-overlay-stage/r8/jobs/tests.sh
# Two suites, both mandatory: tests/test_recovery_overlay.py (r7, unchanged) "Ran 20 tests" and tests/test_diagnostic.py "Ran 13 tests";
# each OK, nothing skipped, empty stdout, no ResourceWarning; peers' mounts/processes identical before and after; no mount left.
set -uo pipefail
source /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/recovery-overlay-stage/r8/jobs/common.sh
guards; mdbx_guards
[ "$(sha256sum < $MDBX_BIN/mk_fixture | cut -c1-64)" = $MK_SHA ] || die "mk_fixture is not the pinned build"
[ "$(df --output=avail -B1 $S | tail -1)" -ge $((2 << 30)) ] || die "less than 2 GiB free for the fixtures"
O=$S/runs/tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p $O && chmod 0700 $S/runs $O && mkdir -m 0700 $O/work $O/work-diag || die "run dir"
peer_snapshot > $O/peers-before.txt
suite() { local name=$1 work=$2
  env -i PATH=$PATH LC_ALL=C RECOVERY_OVERLAY_WORK=$work RECOVERY_OVERLAY_FUSE2FS=$FUSE2FS RECOVERY_OVERLAY_FUSE2FS_SHA256=$FUSE2FS_SHA \
    MDBX_BIN=$MDBX_BIN MDBX_CHK_SHA256=$CHK_SHA MDBX_CHECK_PY=$CHECK_PY MDBX_CHECK_PY_SHA256=$CHECK_PY_SHA \
    timeout -k 10 1800 python3 -I -B -u -W always::ResourceWarning $S/tests/$name.py > $O/$name.stdout 2> $O/$name.stderr; echo $? > $O/$name.rc; }
suite test_recovery_overlay $O/work
suite test_diagnostic $O/work-diag
peer_snapshot > $O/peers-after.txt
python3 -I - "$O" <<'PY' > $O/receipt.json; grc=$?
import json, re, sys
O = sys.argv[1]
def rd(p):
    with open(p) as f:
        return f.read()
r = {}
for name, n in (("test_recovery_overlay", 20), ("test_diagnostic", 13)):
    err, out, rc = rd(f"{O}/{name}.stderr"), rd(f"{O}/{name}.stdout"), int(rd(f"{O}/{name}.rc"))
    lines = [l for l in err.splitlines() if l.strip()]
    s = {"rc": rc, f"ran{n}": len(re.findall(rf"^Ran {n} tests", err, re.M)) == 1, "lastOK": bool(lines) and lines[-1] == "OK",
         "stdoutEmpty": out == "", "clean": not re.search(r"ResourceWarning|skipped|FAIL|ERROR|Traceback", err)}
    s["pass"] = rc == 0 and all(v for k, v in s.items() if k != "rc")
    r[name] = s
r["noMountsLeft"] = not [l for l in rd("/proc/self/mountinfo").splitlines() if O in l]
r["peersUnchanged"] = rd(f"{O}/peers-before.txt") == rd(f"{O}/peers-after.txt")
r["pass"] = r["test_recovery_overlay"]["pass"] and r["test_diagnostic"]["pass"] and r["noMountsLeft"] and r["peersUnchanged"]
print(json.dumps(r, indent=1)); sys.exit(0 if r["pass"] else 1)
PY
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; grc=1; }
cat $O/receipt.json; tail -3 $O/test_recovery_overlay.stderr $O/test_diagnostic.stderr
[ $grc = 0 ] && echo "## PASS (20 + 13)" || echo "## FAIL"
echo "## outputs $O"; echo "## rov-r8-tests rc=$grc"; exit $grc

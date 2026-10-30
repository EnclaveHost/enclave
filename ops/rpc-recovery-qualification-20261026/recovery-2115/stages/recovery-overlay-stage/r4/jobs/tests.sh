#!/bin/bash
# recovery-overlay-stage/r4 FIXTURE tests (prepared by Claude 1660/1674; NOT run by Claude). Unprivileged and NOT under unshare (the FUSE
# mounts need the host fusermount3); only unix sockets in the run dir; nothing outside $O is written. Root:
#   bash jobs/q-exit-status.sh rov-r4-tests 512 bash recovery-overlay-stage/r4/jobs/tests.sh
# Expects: "Ran 20 tests", OK, nothing skipped, empty stdout, no ResourceWarning; peers' mounts/processes identical before and after.
set -uo pipefail
source /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/recovery-overlay-stage/r4/jobs/common.sh
guards
[ "$(df --output=avail -B1 $S | tail -1)" -ge $((2 << 30)) ] || die "less than 2 GiB free for the fixture (about 0.3 GB worst case)"
O=$S/runs/tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p $O && chmod 0700 $S/runs $O && mkdir -m 0700 $O/work || die "run dir"
peer_snapshot > $O/peers-before.txt
env -i PATH=$PATH LC_ALL=C RECOVERY_OVERLAY_WORK=$O/work RECOVERY_OVERLAY_FUSE2FS=$FUSE2FS RECOVERY_OVERLAY_FUSE2FS_SHA256=$FUSE2FS_SHA \
  timeout -k 10 1800 python3 -I -B -u -W always::ResourceWarning $S/tests/test_recovery_overlay.py > $O/stdout.txt 2> $O/stderr.txt; rc=$?
peer_snapshot > $O/peers-after.txt
python3 -I - "$O" "$rc" <<'PY' > $O/receipt.json; grc=$?
import json, re, sys
O, rc = sys.argv[1], int(sys.argv[2])
err, out = open(f"{O}/stderr.txt").read(), open(f"{O}/stdout.txt").read()
lines = [l for l in err.splitlines() if l.strip()]
mounts = [l for l in open("/proc/self/mountinfo") if O in l]
r = {"rc": rc, "ran20": len(re.findall(r"^Ran 20 tests", err, re.M)) == 1, "lastOK": bool(lines) and lines[-1] == "OK", "stdoutEmpty": out == "",
     "clean": not re.search(r"ResourceWarning|skipped|FAIL|ERROR|Traceback", err), "noMountsLeft": not mounts,
     "peersUnchanged": open(f"{O}/peers-before.txt").read() == open(f"{O}/peers-after.txt").read()}
r["pass"] = rc == 0 and all(v for k, v in r.items() if k != "rc")
print(json.dumps(r, indent=1)); sys.exit(0 if r["pass"] else 1)
PY
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; grc=1; }
cat $O/receipt.json; tail -3 $O/stderr.txt
[ $grc = 0 ] && echo "## PASS (20)" || echo "## FAIL"
echo "## outputs $O"; echo "## rov-r4-tests rc=$grc"; exit $grc

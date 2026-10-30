#!/bin/bash
# compact-header-extraction-stage/r1 FIXTURE end-to-end tests (prepared by Claude 1881; NOT run by Claude). Real r9 sessions over the r9
# fixture parent-clean.qcow2 built fresh under $O; never the backup. Unprivileged, NOT under unshare (FUSE needs the host fusermount3). Root:
#   bash jobs/q-exit-status.sh che-r1-e2e 512 bash compact-header-extraction-stage/r1/jobs/e2e-tests.sh
# Expect "## PASS (6)": OK, nothing skipped, peers' mounts/processes identical before and after, no mount or process of $O left.
set -uo pipefail
source /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/recovery-overlay-stage/r9/jobs/common.sh
guards                                                     # r9: not root, r9 SUMS, pinned fuse2fs/qemu tools, FUSE present
C=$P/compact-header-extraction-stage/r1
(cd $C && sha256sum -c --quiet SHA256SUMS) || die "compact-header-extraction-stage/r1 != SHA256SUMS"
[ "$(df --output=avail -B1 $C | tail -1)" -ge $((2 << 30)) ] || die "less than 2 GiB free"
O=$C/runs/e2e-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p -m 0700 $C/runs && mkdir -m 0700 $O $O/work || die "run dir"
peer_snapshot > $O/peers-before.txt
env -i PATH=$PATH LC_ALL=C CHE_WORK=$O/work CHE_FUSE2FS=$FUSE2FS CHE_FUSE2FS_SHA256=$FUSE2FS_SHA \
  timeout -k 10 3600 python3 -I -B -u -W always::ResourceWarning $C/tests/test_extract_e2e.py > $O/stdout 2> $O/stderr; rc=$?
peer_snapshot > $O/peers-after.txt
tail -40 $O/stderr
grc=1
[ $rc = 0 ] && grep -q '^Ran 6 tests' $O/stderr && [ "$(grep -v '^$' $O/stderr | tail -1)" = OK ] \
  && ! grep -qE 'ResourceWarning|skipped|Traceback' $O/stderr && grc=0
grep -qF "$O" /proc/self/mountinfo && { echo "## a mount of $O survived"; grc=1; }
pgrep -f -- "$O" >/dev/null && { echo "## a process of $O survived"; grc=1; }
cmp -s $O/peers-before.txt $O/peers-after.txt || { echo "## peers changed"; grc=1; }
(cd $C && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; grc=1; }
[ $grc = 0 ] && echo "## PASS (6)" || echo "## FAIL (rc $rc)"
echo "## outputs $O"; exit $grc

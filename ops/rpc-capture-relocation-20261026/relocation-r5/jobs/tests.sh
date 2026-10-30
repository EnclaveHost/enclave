#!/bin/bash
# nvme-cold-relocation-stage r5 = r4 tool bytes (relocate.py 2a037dae) + one test-fixture fix + fresh-mtime diagnostic pass.
# r4 was (directory-mtime restore, runtime rsync guard, behavioural no-deletion test, symlink-escape
# refusal, closed files): ROOT-owned offline tests. Also runs the rsync directory-mtime diagnostic first (informational). (temp fixtures only: no real /vm, USB, images, loop devices, mounts or sudo).
#   jobs/q-exit-status.sh <name> 512 unshare -Urn bash nvme-cold-relocation-stage/r5/jobs/tests.sh
# Expects exactly "Ran 22 tests" and "OK" with nothing skipped. Generated sudo scripts are executed ONLY with stub tools
# (id/stat/blkid/mountpoint/install/mount/systemctl/python3 stubs that record argv); no real mount, sudo or systemctl.
# The original stage (8897a4cf), r2 (bead7b1f), r3 (b26a8988) and r4 (a370b3e4) must be unmodified.
set -uo pipefail
export PATH=/usr/bin:/bin
S0=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/nvme-cold-relocation-stage; S=$S0/r5
O=$S/runs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p $O/tmp || exit 9
ip link set lo up 2>/dev/null; ip -4 route 2>/dev/null | grep -q . && { echo "network route present: run under unshare -Urn"; exit 9; }
[ "$(sha256sum < $S0/SHA256SUMS | cut -c1-64)" = 8897a4cf7276b398106f2b50c73c7ade6c6349db18ae6260a612fe5f9f82a853 ] || { echo "original SHA256SUMS changed"; exit 9; }
(cd $S0 && sha256sum -c --quiet SHA256SUMS) || { echo "original stage files changed"; exit 9; }
[ "$(sha256sum < $S0/r2/SHA256SUMS | cut -c1-64)" = bead7b1f5738c5cda46fb177b6795fd08276c51e938bbf12856c004c321e6b20 ] || { echo "r2 SHA256SUMS changed"; exit 9; }
(cd $S0/r2 && sha256sum -c --quiet SHA256SUMS) || { echo "r2 stage files changed"; exit 9; }
[ "$(sha256sum < $S0/r3/SHA256SUMS | cut -c1-64)" = b26a8988ab580b0ce30554cca0989c67a8e209c71eb6197c2e42fddbc9718005 ] || { echo "r3 SHA256SUMS changed"; exit 9; }
(cd $S0/r3 && sha256sum -c --quiet SHA256SUMS) || { echo "r3 stage files changed"; exit 9; }
[ "$(sha256sum < $S0/r4/SHA256SUMS | cut -c1-64)" = a370b3e47206911a542b1e4d75ea39809dc72758083ce324ced10060c795b51b ] || { echo "r4 SHA256SUMS changed"; exit 9; }
(cd $S0/r4 && sha256sum -c --quiet SHA256SUMS) || { echo "r4 stage files changed"; exit 9; }
cmp -s $S0/r4/relocate.py $S/relocate.py || { echo "r5 tool is not byte-identical to r4"; exit 9; }
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "r5 != SHA256SUMS"; exit 9; }
RSYNC=/home/steven/.local/bin/rsync
sha256sum $RSYNC > $O/rsync.sha256
mkdir -p $O/diag && env -i PATH=$PATH timeout -k 5 120 python3 -I $S/jobs/rsync-dir-mtime-diagnostic.py $RSYNC $O/diag > $O/rsync-dir-mtime-diagnostic.jsonl 2>&1
echo "rsync diagnostic rc $? (informational): $O/rsync-dir-mtime-diagnostic.jsonl"
(cd $O && env -i PATH=$PATH RSYNC=$RSYNC TEST_TMP=$O/tmp PYTHONDONTWRITEBYTECODE=1 timeout -k 5 900 python3 -I $S/tests/test_relocate.py) > $O/tests.txt 2>&1; rc=$?
echo "$rc" > $O/tests.rc
tail -4 $O/tests.txt
grep -q "^Ran 22 tests" $O/tests.txt && tail -1 $O/tests.txt | grep -qx "OK" && ! grep -q "skipped" $O/tests.txt && [ $rc = 0 ] \
  && { echo "## nvme-relocation tests: PASS (22/22)"; exit 0; }
echo "## nvme-relocation tests: FAIL (rc $rc)"; exit 1

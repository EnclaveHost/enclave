#!/bin/bash
# nvme-reclamation-stage: ROOT-owned offline tests (temp fixtures only; no real /vm, USB, mounts, sudo or deletion of real data).
#   jobs/q-exit-status.sh <name> 512 unshare -Urn bash nvme-reclamation-stage/jobs/tests.sh
# Requires the frozen relocation r5 (SHA256SUMS 4be4ef83, relocate.py 2a037dae) and exactly "Ran 13 tests" / OK, nothing skipped.
set -uo pipefail
export PATH=/usr/bin:/bin
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$P/nvme-reclamation-stage; R5=$P/nvme-cold-relocation-stage/r5
O=$S/runs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p $O/tmp || exit 9
ip link set lo up 2>/dev/null; ip -4 route 2>/dev/null | grep -q . && { echo "network route present: run under unshare -Urn"; exit 9; }
[ "$(sha256sum < $R5/SHA256SUMS | cut -c1-64)" = 4be4ef837600df81b9e362572225baa50fcd32faf416706e98d4f33b6a82cc20 ] || { echo "r5 SHA256SUMS changed"; exit 9; }
(cd $R5 && sha256sum -c --quiet SHA256SUMS) || { echo "r5 files changed"; exit 9; }
[ "$(sha256sum < $R5/relocate.py | cut -c1-64)" = 2a037dae4bb38df19979b0f7397d44da2d7219f1a55cc455f1e35b8ecb49e3d0 ] || { echo "relocate.py pin"; exit 9; }
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "stage != SHA256SUMS"; exit 9; }
RSYNC=/home/steven/.local/bin/rsync
(cd $O && env -i PATH=$PATH RSYNC=$RSYNC TEST_TMP=$O/tmp PYTHONDONTWRITEBYTECODE=1 timeout -k 5 900 python3 -I $S/tests/test_reclaim.py) > $O/tests.txt 2>&1; rc=$?
echo "$rc" > $O/tests.rc
tail -4 $O/tests.txt
grep -q "^Ran 13 tests" $O/tests.txt && tail -1 $O/tests.txt | grep -qx "OK" && ! grep -q "skipped" $O/tests.txt && [ $rc = 0 ] \
  && { echo "## nvme-reclamation tests: PASS (13/13)"; exit 0; }
echo "## nvme-reclamation tests: FAIL (rc $rc)"; exit 1

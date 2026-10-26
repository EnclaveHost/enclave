#!/bin/bash
# nvme-cold-relocation-stage r6 = r5 relocate.py (byte-identical, 2a037dae; USB-image mode unchanged) + NEW subtree.py
# (directory-destination mode for exactly three codex-archive subtrees -> / ext4). ROOT-owned offline tests on TEMP fixtures only
# (no real /vm, /, archive, home, USB, mounts, sudo, network). Prepared by Claude; NOT run by Claude.
#   bash jobs/q-exit-status.sh cold-r6 512 unshare -Urn bash nvme-cold-relocation-stage/r6/jobs/tests.sh
# Expects: r5 suite "Ran 22 tests" + OK (unchanged tool), subtree suite "Ran 15 tests" + OK, nothing skipped. r1-r5 unmodified.
set -uo pipefail
export PATH=/usr/bin:/bin
S0=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/nvme-cold-relocation-stage; S=$S0/r6
O=$S/runs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p $O/tmp || exit 9
ip link set lo up 2>/dev/null; ip -4 route 2>/dev/null | grep -q . && { echo "network route present: run under unshare -Urn"; exit 9; }
for p in ".:8897a4cf7276b398106f2b50c73c7ade6c6349db18ae6260a612fe5f9f82a853" "r2:bead7b1f5738c5cda46fb177b6795fd08276c51e938bbf12856c004c321e6b20" \
         "r3:b26a8988ab580b0ce30554cca0989c67a8e209c71eb6197c2e42fddbc9718005" "r4:a370b3e47206911a542b1e4d75ea39809dc72758083ce324ced10060c795b51b" \
         "r5:4be4ef837600df81b9e362572225baa50fcd32faf416706e98d4f33b6a82cc20"; do
  d=${p%%:*}; h=${p#*:}
  [ "$(sha256sum < $S0/$d/SHA256SUMS | cut -c1-64)" = "$h" ] && (cd $S0/$d && sha256sum -c --quiet SHA256SUMS) || { echo "$d changed (must stay frozen)"; exit 9; }
done
cmp -s $S0/r5/relocate.py $S/relocate.py || { echo "r6 relocate.py is not byte-identical to r5"; exit 9; }
cmp -s $S0/r5/tests/test_relocate.py $S/tests/test_relocate.py || { echo "r6 copy of the r5 suite differs"; exit 9; }
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "r6 != SHA256SUMS"; exit 9; }
RSYNC=/home/steven/.local/bin/rsync; sha256sum $RSYNC > $O/rsync.sha256
rc=0
for t in test_relocate:22 test_subtree:15; do
  n=${t%%:*}; want=${t#*:}
  (cd $O && env -i PATH=$PATH RSYNC=$RSYNC TEST_TMP=$O/tmp PYTHONDONTWRITEBYTECODE=1 timeout -k 5 900 python3 -I $S/tests/$n.py) > $O/$n.txt 2>&1; r=$?
  tail -3 $O/$n.txt
  if grep -q "^Ran $want tests" $O/$n.txt && tail -1 $O/$n.txt | grep -qx "OK" && ! grep -q "skipped" $O/$n.txt && [ $r = 0 ]; then echo "## $n PASS ($want)"; else echo "## $n FAIL (rc $r)"; rc=1; fi
done
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; rc=1; }
rm -rf $O/tmp; echo "## cold-r6 rc=$rc"; exit $rc

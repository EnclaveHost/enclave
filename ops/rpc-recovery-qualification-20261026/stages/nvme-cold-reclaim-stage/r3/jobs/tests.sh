#!/bin/bash
# nvme-cold-reclaim-stage r3 = reclaim.py (r2 + the FROZEN r9 API: pins, 18-key result, 3 tools, entries/dev/majmin binding; the
# .retire top is never renamed so a deleted inode keeps r9's prefix (A7); confirm = scan B + fresh full re-hash of the retained copy)
# on TEMP fixtures only. It drives the REAL frozen r9 phases and r9's REAL phase_writer_check over owned fixture /proc trees and
# over the real /proc of ONE owned child process (A7). No real /vm, /, archive, home, sudo, network or global scan.
# Prepared by Claude; NOT run by Claude.
#   bash jobs/q-exit-status.sh cold-reclaim-r3 512 unshare -Urn bash nvme-cold-reclaim-stage/r3/jobs/tests.sh
# Expects: "Ran 11 tests" + OK, nothing skipped; reclaim r1/r2, relocation r8/r9 frozen and unchanged; no bytecode in r3 or r9.
set -uo pipefail
export PATH=/usr/bin:/bin
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$W/nvme-cold-reclaim-stage/r3; S8=$W/nvme-cold-relocation-stage
O=$S/runs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p $O/tmp || exit 9
ip link set lo up 2>/dev/null; ip -4 route 2>/dev/null | grep -q . && { echo "network route present: run under unshare -Urn"; exit 9; }
for p in "$W/nvme-cold-reclaim-stage/r1:faa561cbe9a22a3c1d8ed17fd929929e0a034bc8cd5f8179babf3c07466ba559" \
         "$W/nvme-cold-reclaim-stage/r2:4b0cd38d638da219d34025fe2c3bde0f57ca1782eb034b0bf307b89903f62931" \
         "$S8/r8:433fd1314c96c48b5f1abbf0cd5e740efa50a9498ad63ac71f1107d0436bb0c2" "$S8/r9:cc4d7cd373a22c2f37bf7c5cd26eae06a5e84a644363b8d508fa34b35e598f5d"; do
  d=${p%%:*}; h=${p#*:}
  [ "$(sha256sum < $d/SHA256SUMS | cut -c1-64)" = "$h" ] && (cd $d && sha256sum -c --quiet SHA256SUMS) || { echo "$d changed (must stay frozen)"; exit 9; }
done
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "r3 != SHA256SUMS"; exit 9; }
nobc() { [ -z "$(find $S $S8/r9 \( -path $S/runs -o -path $S8/r9/runs \) -prune -o \( -name __pycache__ -o -name '*.pyc' \) -print)" ]; }
nobc || { echo "bytecode inside r3 or r9"; exit 9; }
RSYNC=/home/steven/.local/bin/rsync; sha256sum $RSYNC > $O/rsync.sha256
rc=0; n=test_reclaim; want=11
(cd $O && env -i PATH=$PATH RSYNC=$RSYNC TEST_TMP=$O/tmp timeout -k 5 900 python3 -I -B $S/tests/$n.py) > $O/$n.txt 2>&1; r=$?
tail -3 $O/$n.txt
if grep -q "^Ran $want tests" $O/$n.txt && tail -1 $O/$n.txt | grep -qx "OK" && ! grep -q "skipped" $O/$n.txt && [ $r = 0 ]; then echo "## $n PASS ($want)"; else echo "## $n FAIL (rc $r)"; rc=1; fi
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; rc=1; }
for d in $W/nvme-cold-reclaim-stage/r1 $W/nvme-cold-reclaim-stage/r2 $S8/r8 $S8/r9; do (cd $d && sha256sum -c --quiet SHA256SUMS) || { echo "## $d changed during the run"; rc=1; }; done
nobc || { echo "## bytecode written during the run"; rc=1; }
rm -rf $O/tmp; echo "## cold-reclaim-r3 rc=$rc"; exit $rc

#!/bin/bash
# nvme-cold-reclaim-stage r1 = reclaim.py (one-time unprivileged reclamation of the three r8 .retire-* trees) on TEMP fixtures only
# (no real /vm, /, archive, home, mounts, sudo, network). It drives the REAL frozen r8 phases to produce the state it consumes.
# Prepared by Claude; NOT run by Claude.
#   bash jobs/q-exit-status.sh cold-reclaim-r1 512 unshare -Urn bash nvme-cold-reclaim-stage/r1/jobs/tests.sh
# Expects: "Ran 10 tests" + OK, nothing skipped; r7/r8 frozen and unchanged; no bytecode in r1 or r8.
set -uo pipefail
export PATH=/usr/bin:/bin
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$W/nvme-cold-reclaim-stage/r1; S8=$W/nvme-cold-relocation-stage
O=$S/runs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p $O/tmp || exit 9
ip link set lo up 2>/dev/null; ip -4 route 2>/dev/null | grep -q . && { echo "network route present: run under unshare -Urn"; exit 9; }
for p in "r7:0ee124ad3a239173f177b19be489cae23270bd740dd79205c7c4d34a1da9c701" "r8:433fd1314c96c48b5f1abbf0cd5e740efa50a9498ad63ac71f1107d0436bb0c2"; do
  d=${p%%:*}; h=${p#*:}
  [ "$(sha256sum < $S8/$d/SHA256SUMS | cut -c1-64)" = "$h" ] && (cd $S8/$d && sha256sum -c --quiet SHA256SUMS) || { echo "$d changed (must stay frozen)"; exit 9; }
done
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "r1 != SHA256SUMS"; exit 9; }
nobc() { [ -z "$(find $S $S8/r8 \( -path $S/runs -o -path $S8/r8/runs \) -prune -o \( -name __pycache__ -o -name '*.pyc' \) -print)" ]; }
nobc || { echo "bytecode inside r1 or r8"; exit 9; }
RSYNC=/home/steven/.local/bin/rsync; sha256sum $RSYNC > $O/rsync.sha256
rc=0; n=test_reclaim; want=10
(cd $O && env -i PATH=$PATH RSYNC=$RSYNC TEST_TMP=$O/tmp timeout -k 5 900 python3 -I -B $S/tests/$n.py) > $O/$n.txt 2>&1; r=$?
tail -3 $O/$n.txt
if grep -q "^Ran $want tests" $O/$n.txt && tail -1 $O/$n.txt | grep -qx "OK" && ! grep -q "skipped" $O/$n.txt && [ $r = 0 ]; then echo "## $n PASS ($want)"; else echo "## $n FAIL (rc $r)"; rc=1; fi
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; rc=1; }
for d in r7 r8; do (cd $S8/$d && sha256sum -c --quiet SHA256SUMS) || { echo "## $d changed during the run"; rc=1; }; done
nobc || { echo "## bytecode written during the run"; rc=1; }
rm -rf $O/tmp; echo "## cold-reclaim-r1 rc=$rc"; exit $rc

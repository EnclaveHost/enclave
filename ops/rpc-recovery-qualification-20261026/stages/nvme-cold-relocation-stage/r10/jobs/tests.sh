#!/bin/bash
# nvme-cold-relocation-stage r10 = r5 relocate.py (byte-identical, 2a037dae; USB-image mode unchanged) + subtree.py r10 (r9 + r9 review
# B1 no-follow staging, B2 no-follow fd walk without silent skips, G1 overlay layers, G2 per-thread mount ns, G3 unknown fanotify marks). ROOT runs it, offline, in an UNPRIVILEGED
# user namespace (required: the actual-/proc visibility test and the actual bind-mount alias fixture in a child mount namespace rely on it).
# TEMP fixtures only (no real /vm, /, archive, home, USB, sudo, network; the child mount namespace is private and dies with the test).
# Prepared by Claude; NOT run by Claude.
#   bash jobs/q-exit-status.sh cold-r10 512 unshare -Urn bash nvme-cold-relocation-stage/r10/jobs/tests.sh
# Expects: r5 suite "Ran 22 tests" + OK (unchanged tool), subtree suite "Ran 39 tests" + OK, nothing skipped; the original stage and r2-r9 unmodified.
set -uo pipefail
export PATH=/usr/bin:/bin
S0=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/nvme-cold-relocation-stage; S=$S0/r10
O=$S/runs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p $O/tmp || exit 9
ip link set lo up 2>/dev/null; ip -4 route 2>/dev/null | grep -q . && { echo "network route present: run under unshare -Urn"; exit 9; }
read -r u0 u1 u2 < /proc/self/uid_map; [ "$u0 $u1 $u2" != "0 0 4294967295" ] || { echo "not in a user namespace: run under unshare -Urn"; exit 9; }
for p in ".:8897a4cf7276b398106f2b50c73c7ade6c6349db18ae6260a612fe5f9f82a853" "r2:bead7b1f5738c5cda46fb177b6795fd08276c51e938bbf12856c004c321e6b20" \
         "r3:b26a8988ab580b0ce30554cca0989c67a8e209c71eb6197c2e42fddbc9718005" "r4:a370b3e47206911a542b1e4d75ea39809dc72758083ce324ced10060c795b51b" \
         "r5:4be4ef837600df81b9e362572225baa50fcd32faf416706e98d4f33b6a82cc20" "r6:b50c3c88d698637169498abdc58bbb9e7e000ee70810ee4f10c7d9bd631df27b" \
         "r7:0ee124ad3a239173f177b19be489cae23270bd740dd79205c7c4d34a1da9c701" "r8:433fd1314c96c48b5f1abbf0cd5e740efa50a9498ad63ac71f1107d0436bb0c2" \
         "r9:cc4d7cd373a22c2f37bf7c5cd26eae06a5e84a644363b8d508fa34b35e598f5d"; do
  d=${p%%:*}; h=${p#*:}
  [ "$(sha256sum < $S0/$d/SHA256SUMS | cut -c1-64)" = "$h" ] && (cd $S0/$d && sha256sum -c --quiet SHA256SUMS) || { echo "$d changed (must stay frozen)"; exit 9; }
done
cmp -s $S0/r5/relocate.py $S/relocate.py || { echo "r10 relocate.py is not byte-identical to r5"; exit 9; }
cmp -s $S0/r5/tests/test_relocate.py $S/tests/test_relocate.py || { echo "r10 copy of the r5 suite differs"; exit 9; }
cmp -s $S0/r8/config.subtree.production.template.json $S/config.subtree.production.template.json || { echo "r10 config template differs from r8"; exit 9; }
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "r10 != SHA256SUMS"; exit 9; }
[ -z "$(find $S -path $S/runs -prune -o \( -name __pycache__ -o -name '*.pyc' \) -print)" ] || { echo "bytecode inside r10 (r10 never runs or keeps a pyc)"; exit 9; }
RSYNC=/home/steven/.local/bin/rsync; sha256sum $RSYNC > $O/rsync.sha256
rc=0
for t in test_relocate:22 test_subtree:39; do
  n=${t%%:*}; want=${t#*:}
  (cd $O && env -i PATH=$PATH RSYNC=$RSYNC TEST_TMP=$O/tmp PYTHONDONTWRITEBYTECODE=1 timeout -k 5 900 python3 -I -B $S/tests/$n.py) > $O/$n.txt 2>&1; r=$?
  tail -3 $O/$n.txt
  if grep -q "^Ran $want tests" $O/$n.txt && tail -1 $O/$n.txt | grep -qx "OK" && ! grep -q "skipped" $O/$n.txt && [ $r = 0 ]; then echo "## $n PASS ($want)"; else echo "## $n FAIL (rc $r)"; rc=1; fi
done
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; rc=1; }
[ -z "$(find $S -path $S/runs -prune -o \( -name __pycache__ -o -name '*.pyc' \) -print)" ] || { echo "## bytecode written into r10 during the run"; rc=1; }
rm -rf $O/tmp; echo "## cold-r10 rc=$rc"; exit $rc

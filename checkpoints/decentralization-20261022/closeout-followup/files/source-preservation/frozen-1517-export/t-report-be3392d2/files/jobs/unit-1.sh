#!/bin/bash
# S and P unit suites on the composed clones (existing + new network-layout tests), loopback-only namespace.
set -u
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-hdd-storage-compose-20261023
rc=0
cd "$W/s/holder" && HOLDER_GIT_REPO="$W/s" HOLDER_NVME_SCRATCH="$W/scratch" JOB_SEC=400 ./run-tests.sh holder || rc=1
echo "=== S test_network_layout"
timeout -k 5 120 python3 -I "$W/s/holder/test/test_network_layout.py" || rc=1
cd "$W/p/l1pair" || exit 2
for f in test/test_l1pair.py test/test_network_layout.py; do
  echo "=== P $f"; timeout -k 5 300 unshare --user --map-root-user --net sh -c 'ip link set lo up; python3 -I "$0"' "$f" || rc=1
done
echo "unit rc=$rc"; exit $rc

#!/bin/bash
# holder offline tests inside a private user+network namespace (loopback only). Through the shared queue:
#   python3 -u work/claude-test-queue.py --mib 256 --log LOG -- holder/run-tests.sh [holder|reth]
set -u
cd "$(dirname "$0")" || exit 2
sha256sum holder.py holder-storage.sh.in drill-cache.sh FLAGS.json holder.example.json test/*.py test/stubs/stubcmd.py
suites=${1:-holder}
export HOLDER_NVME_SCRATCH=${HOLDER_NVME_SCRATCH:-/home/steven/Documents/Codex/2026-10-18/wo/work/fresh-witness-supply/test-scratch}
export B_REPO=${B_REPO:-/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-runtime-composition/repo}
export RETH_BIN=${RETH_BIN:-/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-priority/vendor-inspect/reth-v2.8.0/bin/reth}
exec timeout -k 10 "${JOB_SEC:-300}" unshare --user --map-root-user --net sh -c '
  ip link set lo up || exit 2
  rc=0
  for s in $0; do case $s in holder) f="test/test_holder.py test/test_storage.py";; reth) f=test/test_reth_dev.py;; esac
    for g in $f; do echo "=== $g"; python3 -I $g || rc=1; done; done
  exit $rc' "$suites"

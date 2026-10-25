#!/bin/bash
# Offline regression job for the Base retention candidate (claude-test-queue.py --mib 256; unshare -rn).
set -u
cd "$(dirname "$0")"
export TEST_TMP="$PWD/tmp"
export REAL_SNAPSHOT_MANIFEST=/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/base-download-tuning/snapshot-manifest-observed.json
rc=0
for t in test_chain_service.py test_coverage_activation.py; do echo "=== $t"; python3 -I "$t" -v 2>&1 || rc=1; done
exit $rc

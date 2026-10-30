#!/bin/bash
# Offline test job for the coverage activation bridge (claude-test-queue.py --mib 256; run inside unshare -rn).
set -u
cd "$(dirname "$0")"
export TEST_TMP="$PWD/tmp"
# actual observed raw manifest (not published): staging must run it
export REAL_SNAPSHOT_MANIFEST=/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/base-download-tuning/snapshot-manifest-observed.json
rc=0
for t in test_coverage_activation.py test_chain_service.py; do
  echo "=== $t"; python3 -I "$t" -v 2>&1 || rc=1
done
echo "=== mutants (each must be KILLED)"
for m in mutants/*.py; do
  if CHAIN_SERVICE="$PWD/$m" python3 -I test_coverage_activation.py > "$m.out" 2>&1; then echo "SURVIVED $m"; rc=1; else echo "KILLED $m"; fi
done
exit $rc

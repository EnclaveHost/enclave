#!/bin/bash
# Offline regression job for the Base retention candidate (claude-test-queue.py --mib 256; unshare -rn).
set -u
cd "$(dirname "$0")"
export TEST_TMP="$PWD/tmp"
export REAL_SNAPSHOT_MANIFEST=/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/base-download-tuning/snapshot-manifest-observed.json
rc=0
for t in test_chain_service.py test_coverage_activation.py; do echo "=== $t"; python3 -I "$t" -v 2>&1 || rc=1; done

echo "=== test_cached_download_preflight.py"; python3 -I test_cached_download_preflight.py 2>&1 || rc=1
echo "=== real-manifest option B model (files 105-106/headers/state present; 96-104 missing; free modeled)"
python3 -I - <<'PY' || rc=1
import json, sys, os; sys.path.insert(0, os.getcwd()); import cached_download_preflight as pf
m = json.load(open('/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/base-download-tuning/snapshot-manifest-observed.json'))
p = pf.plan(m, 48_000_000, 52_500_000)
miss = [x for x in p['missingArchives'] if x['chunk'] < 105]
c = sum(x['compressed'] for x in miss); e = sum(x['extracted'] for x in miss)
est = pf.index_reserve_estimate(m, 48_000_000); idx = max(2 * est, pf.MIN_INDEX_RESERVE); g = pf.daily_growth(m) * 30
vol = 3_100_000_000_000; existing = 1_274_290_000_000
free_model = int(vol * 0.99) - existing
need = c + e + idx + g
print(json.dumps({'missingArchives': len(miss), 'compressedGB': round(c/1e9,1), 'extractedGB': round(e/1e9,1), 'indexEstimateGB': round(est/1e9,1),
  'indexReserveGB': round(idx/1e9,1), 'dailyGrowthGB': round(pf.daily_growth(m)/1e9,2), 'growth30dGB': round(g/1e9,1), 'needGB': round(need/1e9,1),
  'freeModelGB(3.1TB*0.99-1.274TB)': round(free_model/1e9,1), 'headroomModelGB': round((free_model-need)/1e9,1),
  'afterExtractUsedGB': round((existing+e)/1e9,1)}, indent=1))
PY

exit $rc

#!/bin/bash
# witness-rpc-live-canary-stage/r2: bounded OFFLINE tests (fake ssh guest, fake host meminfo; no guest, no network). Via the shared queue:
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && ./jobs/q-exit-status.sh wbc-offline-1 512 unshare -Urn bash witness-rpc-live-canary-stage/r2/jobs/root-offline-tests.sh
set -uo pipefail; export PATH=/usr/bin:/bin
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; ST=$P/witness-rpc-live-canary-stage/r2; R14=$P/base-finality-proof-stage/r14-witness
ip -o route 2>/dev/null | grep -q . && { echo "## wbc-offline rc=9 (network)"; exit 9; }
(cd $ST && sha256sum -c --quiet SHA256SUMS) || { echo "## wbc-offline rc=9 (stage changed)"; exit 9; }
[ "$(sha256sum < $R14/SHA256SUMS | cut -c1-64)" = 1ba2d51a47d0576cada1e0e24b885234e39c6c53f4e6af5e8c9e5ee5e921793b ] && (cd $R14 && sha256sum -c --quiet SHA256SUMS) || { echo "## wbc-offline rc=9 (r14 changed)"; exit 9; }
OUT=$ST/logs/offline-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p $OUT/tmp
(cd $ST && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp timeout 900 /usr/bin/python3 -I -B tests/test_fixture_canary.py -v < /dev/null) > $OUT/tests.txt 2>&1; r=$?
ran=$(grep -oE '^Ran [0-9]+ tests' $OUT/tests.txt | grep -oE '[0-9]+'); last=$(grep -E '^(OK|FAILED)' $OUT/tests.txt | tail -1)
if [ $r = 0 ] && [ "$ran" = 10 ] && [ "$last" = OK ] && ! grep -qE 'skipped|expected failure' $OUT/tests.txt; then echo "PASS wbc-offline Ran $ran"; rc=0
else echo "## FAIL: rc $r Ran ${ran:-?} last ${last:-none} (see $OUT/tests.txt)"; rc=1; fi
echo "## wbc-offline SHA256SUMS $(sha256sum < $ST/SHA256SUMS | cut -c1-64)"; echo "## wbc-offline rc=$rc"; exit $rc

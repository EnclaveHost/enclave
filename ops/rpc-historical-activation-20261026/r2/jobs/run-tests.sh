#!/bin/bash
# historical-origin-segments-stage/r2: ROOT-OWNED OFFLINE targeted tests (r1 bytes + root's r1 failure log preserved untouched).
# Root runs it in the FOREGROUND via the shared queue inside a private user+net namespace:
#   jobs/q-exit-status.sh root-historical-origin-r2-tests-N 512 unshare -Urn bash historical-origin-segments-stage/r2/jobs/run-tests.sh
# No network (route check), loopback only for the fake L1; private TMPDIR removed on ANY exit; no bytecode written into source/.
# PASS only if: r2 SHA256SUMS verify, every pinned input verifies, and the unittest.TestResult receipt (tests/run_all.py) shows
# testsRun 25, failures/errors/skipped/expectedFailures/unexpectedSuccesses all 0.
set -uo pipefail
export PATH=/usr/bin:/bin
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$W/historical-origin-segments-stage/r2
C=$W/source/ops/rpc-backend-bootstrap/2026-10-25
OUT=$S/logs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$; PT=""
die() { echo "## SETUP: $*"; echo "SETUP-FAIL $*" > "$OUT/RESULT"; exit 9; }
trap '[ -n "$PT" ] && rm -rf --one-file-system -- "$PT"' EXIT
mkdir -p "$OUT"
ip link set lo up 2>/dev/null; ip -o addr show lo 2>/dev/null | grep -q '127.0.0.1' || die "loopback is not up"
ip -o route 2>/dev/null | grep -v '127.0.0.0/8\|dev lo' | grep -q . && die "network route present: run under unshare -Urn"
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || die "stage != SHA256SUMS"
pin() { [ "$(sha256sum < "$1" | cut -c1-64)" = "$2" ] || die "$1 is not $2"; }
pin $C/coverage/coverage_gate.py b4f6d639c3f9b12f73938d5993ce0897fe56dcbec1ada3123c4ad80d0ff3854b
pin $C/coverage/origin_extract.py 6b63b901ea07375ea273fd828cb0d0e97baa0859c1b83490c1cb60e15cb3c86c
pin $C/coverage/test_coverage_gate.py 5d5d8604e41f920ab72eb964516ae3b0a228824207fc5b6ab8ee4244d104fc14
pin $C/coverage/test_origin_extract.py b9b026da24f4b73c5a7918537fc58e9e72c2058e213a15bb858f6ee8c412d4df
pin $C/chain_service.py 75c879ec9c5728688beac8cc98ecf1410c38f29c144b27fabd8b42ea60cfbc92
pin $C/test_coverage_activation.py 24c37c51d20f164434739093dd513d9206968e0ac60aec1ba59271b1116fa6f7
pin $C/l1-anchor-a1/live-1958/a1-evidence.json b9a90847bb3f779262681cabc35af64d7c3b785c9ad5cd2b99e9700b9725256c
pin $W/base-finality-proof-stage/r12-final/vendor/anchor-bootstrap.mjs 90a8afba31e7c7029a0fa860f97153cd40665f1d1b2ae87bb0a56fd98c25e8f8
pin $W/source/node_modules/@noble/hashes/sha3.js 313da3570150e80b02c3631508ba99099438d2daff641b9cadb2198e0f1d18ec
pin $W/coverage-stage/kzgcheck/target/release/kzgcheck 00b3eeb94efece39e4f2cf8e34d5d3450d532328ccc667a6a74e83b151be10eb
PT=$(mktemp -d /tmp/hos-tests.XXXXXX) || die "mktemp"
export TMPDIR=$PT KZGCHECK=$W/coverage-stage/kzgcheck/target/release/kzgcheck NODE=/usr/bin/node PYTHONDONTWRITEBYTECODE=1
{ echo "node $($NODE --version) python $(python3 --version 2>&1) uid $(id -u)"; sha256sum < "$S/SHA256SUMS"; } > "$OUT/env.txt"
cd "$S/tests" && timeout 1200 python3 -B run_all.py "$OUT/receipt.json" "$OUT/unittest.txt" 25 > "$OUT/summary.txt" 2>"$OUT/stderr.txt"
rc=$?
if [ $rc -eq 0 ] && python3 -B -c 'import json,sys; d=json.load(open(sys.argv[1])); c=d["counts"]
sys.exit(0 if d["pass"] is True and c=={"testsRun":25,"failures":0,"errors":0,"skipped":0,"expectedFailures":0,"unexpectedSuccesses":0} else 1)' "$OUT/receipt.json"; then
  echo "PASS historical-origin-segments-r2 testsRun 25 failures 0 errors 0 skipped 0 rc 0" > "$OUT/RESULT"
else
  echo "FAIL historical-origin-segments-r2 rc $rc $(cat "$OUT/summary.txt" 2>/dev/null)" > "$OUT/RESULT"; [ $rc -eq 0 ] && rc=1
fi
cat "$OUT/summary.txt" "$OUT/RESULT"; echo "## out $OUT"
exit $rc

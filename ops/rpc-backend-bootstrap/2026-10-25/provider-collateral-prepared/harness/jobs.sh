#!/bin/bash
# Offline (unshare -rn, loopback only) job for the provider collateral fix. Shared queue --mib 256. No source is modified:
# the baseline runs the ORIGINAL attested-authority.mjs through a symlink farm under tmp/.
set -u
cd "$(dirname "$0")"; STAGE=$PWD; R=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/attested-route-source
ip link set lo up
export TMPDIR=$STAGE/tmp NODE_OPTIONS=--max-old-space-size=192
mkdir -p "$TMPDIR"
sha256sum $R/network/wg-provider/attested-authority.mjs $R/test/attested-provider-collateral.test.mjs $R/verifier/collateral-cache.mjs $R/verifier/collateral.mjs $R/network/attested-verifier-client.mjs orig/attested-authority.mjs
rc=0
echo "=== focused collateral test + existing attested route composition, paid provider, collateral cache"
(cd $R && timeout -k 10 470 node --test --test-concurrency=1 --test-timeout=180000 test/attested-provider-collateral.test.mjs test/attested-route-composition.test.mjs test/attested-paid-provider.test.mjs test/verifier-collateral-cache.test.mjs 2>&1) || rc=1
echo "=== baseline: ORIGINAL attested-authority.mjs ee1ce253 + the focused test (MUST fail)"
B=$STAGE/tmp/baseline; rm -rf "$B"; mkdir -p "$B/network/wg-provider"
for e in $R/* $R/.[!.]*; do n=$(basename "$e"); [ "$n" = network ] || ln -s "$e" "$B/$n"; done
for e in $R/network/*; do n=$(basename "$e"); [ "$n" = wg-provider ] || ln -s "$e" "$B/network/$n"; done
for e in $R/network/wg-provider/*; do n=$(basename "$e"); [ "$n" = attested-authority.mjs ] || ln -s "$e" "$B/network/wg-provider/$n"; done
cp orig/attested-authority.mjs "$B/network/wg-provider/attested-authority.mjs"
sha256sum "$B/network/wg-provider/attested-authority.mjs"
(cd "$B" && timeout -k 5 90 node --preserve-symlinks --preserve-symlinks-main test/attested-provider-collateral.test.mjs) > "$STAGE/tmp/baseline.out" 2>&1; b=$?
grep -E "^not ok|^# (tests|pass|fail)|(ℹ|#) (pass|fail) " "$STAGE/tmp/baseline.out" | head -20
if [ $b -ne 0 ] && grep -qE "(# |ℹ )fail [1-9]" "$STAGE/tmp/baseline.out"; then echo "BASELINE FAILS AS REQUIRED"; else echo "BASELINE DID NOT FAIL"; rc=1; fi
echo "job rc=$rc"
exit $rc

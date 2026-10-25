#!/bin/bash
# Repair re-run (after root-collateral-2134-768: 34 pass, 2 fail). Offline (unshare -rn), shared queue --mib 768.
# Pass criteria: every suite test ok AND all five source-weakened mutants KILLED by assertion. The ORIGINAL-file baseline is
# informational only (it mostly fails on the then-unknown cacheDir key: config errors are never counted as mutant kills).
set -u
cd "$(dirname "$0")"; STAGE=$PWD; R=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/attested-route-source
ip link set lo up
export TMPDIR=$STAGE/tmp
mkdir -p "$TMPDIR"
sha256sum $R/network/wg-provider/attested-authority.mjs $R/test/attested-provider-collateral.test.mjs $R/verifier/collateral-cache.mjs $R/verifier/collateral.mjs $R/verifier/snp.mjs $R/network/attested-verifier-client.mjs orig/attested-authority.mjs mutants.mjs
rc=0
echo "=== suite: focused collateral test + existing attested route composition, paid provider, collateral cache"
(cd $R && timeout -k 10 400 node --test --test-concurrency=1 --test-timeout=180000 test/attested-provider-collateral.test.mjs test/attested-route-composition.test.mjs test/attested-paid-provider.test.mjs test/verifier-collateral-cache.test.mjs 2>&1) || rc=1
echo "=== source-weakened mutants of the CURRENT authority file (assertion kills only)"
timeout -k 5 120 node mutants.mjs "$R" || rc=1
echo "=== informational: ORIGINAL attested-authority.mjs ee1ce253 + the focused test (not a pass criterion)"
B=$STAGE/tmp/baseline2; rm -rf "$B"; mkdir -p "$B/network/wg-provider"
for e in $R/* $R/.[!.]*; do n=$(basename "$e"); [ "$n" = network ] || ln -s "$e" "$B/$n"; done
for e in $R/network/*; do n=$(basename "$e"); [ "$n" = wg-provider ] || ln -s "$e" "$B/network/$n"; done
for e in $R/network/wg-provider/*; do n=$(basename "$e"); [ "$n" = attested-authority.mjs ] || ln -s "$e" "$B/network/wg-provider/$n"; done
cp orig/attested-authority.mjs "$B/network/wg-provider/attested-authority.mjs"
(cd "$B" && timeout -k 5 60 node --preserve-symlinks --preserve-symlinks-main --test-reporter=tap test/attested-provider-collateral.test.mjs) > "$STAGE/tmp/baseline2.out" 2>&1
grep -E "^(not ok|ok) [0-9]+ - |^# (tests|pass|fail)" "$STAGE/tmp/baseline2.out"
echo "job rc=$rc"
exit $rc

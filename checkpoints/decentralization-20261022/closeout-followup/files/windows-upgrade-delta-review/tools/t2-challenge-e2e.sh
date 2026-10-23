#!/usr/bin/env bash
# t2 (queue 768): t1's one environment gap closed - the end-to-end challenge test builds the replica release from the
# gitignored relay/network-runtime.bundle.mjs, so relay/build-network.mjs runs first (as F's recipe does). Then:
#   V0 = F 4106c311 exactly, F's own test/challenge-replica-host.test.mjs (5ef2b89c = 32fecf5's, unchanged by F)
#   V1 = the port (t1's V1 files) with the INSTALLED test/challenge-replica-host.test.mjs f9918823 - which is also the clean
#        3-way merge (installed, base 32fecf5, F): F never changed this test
# A proposal for F to judge, not F's tree: a throwaway clone, removed at the end.
set -uo pipefail
. "$(dirname "$0")/env.sh"
FC=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-services-final-compose/candidate
R2=/home/steven/Documents/Codex/2026-10-18/wo/work/g4-config-independent-review-20261021/revision2/network-tree
L=$B/tmp/lineage; X=$B/tmp/t2; [ ! -e "$X" ] || { echo "$X exists"; exit 2; }
want(){ [ "$(sha256sum < "$1" | cut -c1-64)" = "$2" ] || { echo "HASH MISMATCH $1"; exit 4; }; }
want "$L/crh-merge3.mjs" 93bc81fda381e0d775f72453f32027d3a1ae7d1d3ef62bb04a50d238c4c813c8
want "$R2/network/enclave-network-host.mjs" 2c1b84aa842e22c1a6e803f5eb8c3b98b7b3609d76ad3ef40994636976234327
want "$L/crht-merged.mjs" "$(sha256sum < "$R2/test/challenge-replica-host.test.mjs" | cut -c1-64)"
git clone -q --local --no-hardlinks --no-checkout "$FC" "$X"; git -C "$X" -c advice.detachedHead=false checkout -q 4106c3114dd13f39692195c182d3152efa5e212c
for d in . network relay; do [ -d "$FC/$d/node_modules" ] && cp -a "$FC/$d/node_modules" "$X/$d/node_modules"; done
(cd "$X" && node relay/build-network.mjs >/dev/null) || { echo "build-network failed"; exit 6; }
echo "relay/network-runtime.bundle.mjs $(sha256sum < "$X/relay/network-runtime.bundle.mjs" | cut -c1-12)"
mkdir -p "$B/receipts/t2"
run(){ # $1 variant
  echo "=== $1: challenge-replica-host $(sha256sum < "$X/network/challenge-replica-host.mjs" | cut -c1-12) enclave-network-host $(sha256sum < "$X/network/enclave-network-host.mjs" | cut -c1-12) test $(sha256sum < "$X/test/challenge-replica-host.test.mjs" | cut -c1-12)"
  ( cd "$X" && timeout 400 node --test --test-concurrency=1 --test-reporter=tap test/challenge-replica-host.test.mjs ) > "$B/receipts/t2/$1-challenge-replica-host.tap" 2>&1; rc=$?
  echo "[$1] rc=$rc $(grep -E '^# (pass|fail|skipped|cancelled) ' "$B/receipts/t2/$1-challenge-replica-host.tap" | tr '\n' ' ')"
  grep -E '^(ok|not ok)' "$B/receipts/t2/$1-challenge-replica-host.tap" | cut -c1-140 | sed "s/^/[$1]   /"; }
run V0
cp "$L/crh-merge3.mjs" "$X/network/challenge-replica-host.mjs"
cp "$R2/network/enclave-network-host.mjs" "$X/network/enclave-network-host.mjs"
cp "$R2/network/challenge-front-declaration.mjs" "$X/network/challenge-front-declaration.mjs"
cp "$L/crht-merged.mjs" "$X/test/challenge-replica-host.test.mjs"
run V1
rm -rf "$X"
n=$(grep -vc " -V stub-proof$" "$B/stub/invocations.log" || true); [ "$n" -eq 0 ] || { echo "stub invoked $n times"; exit 5; }
echo T2-DONE

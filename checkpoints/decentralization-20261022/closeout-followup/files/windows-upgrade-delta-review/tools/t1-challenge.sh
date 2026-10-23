#!/usr/bin/env bash
# t1 (queue 768): does F 4106c311 keep the INSTALLED challenge lifecycle (cfb69370: background retry, progress readiness,
# admin recheck, cancellation) and the managed front? The installed tree's own reviewed tests (root retry review 21/21 on
# revision2/network-tree) run against:
#   V0 = F 4106c311 exactly (expected to FAIL: F's challenge files are the older 32fecf5 baseline's plus the carrier edit)
#   V1 = F 4106c311 + the port: challenge-replica-host = git merge-file(installed 9c3e4d10, base 32fecf5, F 52e02b93) (clean),
#        enclave-network-host = installed 2c1b84aa (F's is 32fecf5's byte-for-byte), challenge-front-declaration = installed 67e67a01
# plus F's own suites that import those modules, on both (a V1 failure that also fails on V0 is pre-existing).
# A proposal for F to judge, not F's tree: everything happens in a throwaway clone that is removed at the end.
set -uo pipefail
. "$(dirname "$0")/env.sh"
FC=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-services-final-compose/candidate
R2=/home/steven/Documents/Codex/2026-10-18/wo/work/g4-config-independent-review-20261021/revision2/network-tree
L=$B/tmp/lineage; X=$B/tmp/t1; [ ! -e "$X" ] || { echo "$X exists"; exit 2; }
want(){ [ "$(sha256sum < "$1" | cut -c1-64)" = "$2" ] || { echo "HASH MISMATCH $1"; exit 4; }; }
want "$R2/network/challenge-replica-host.mjs" 9c3e4d1048119417dbf7dac3ace03d66a0f8ad9d1d1734f470040fe2bdbd1d1e
want "$R2/network/enclave-network-host.mjs" 2c1b84aa842e22c1a6e803f5eb8c3b98b7b3609d76ad3ef40994636976234327
want "$R2/test/challenge-replica-supervise.test.mjs" 1dbd849d6d3f15a2e599695fc3210a8f38578c3e74b86ac05e4e43f8aa2cf068
git clone -q --local --no-hardlinks --no-checkout "$FC" "$X"; git -C "$X" -c advice.detachedHead=false checkout -q 4106c3114dd13f39692195c182d3152efa5e212c
for d in . network relay; do [ -d "$FC/$d/node_modules" ] && cp -a "$FC/$d/node_modules" "$X/$d/node_modules"; done
INST="challenge-replica-supervise challenge-replica-host challenge-front-managed"
for t in $INST; do cp "$R2/test/$t.test.mjs" "$X/test/installed-$t.test.mjs"; done
OWN="challenge-replica-host enclave-network-host-canary privacy-agent-lifecycle network-policy-outage local-byo-config"
run(){ # $1 variant
  echo "=== $1: challenge-replica-host $(sha256sum < "$X/network/challenge-replica-host.mjs" | cut -c1-12) enclave-network-host $(sha256sum < "$X/network/enclave-network-host.mjs" | cut -c1-12) front-declaration $( [ -e "$X/network/challenge-front-declaration.mjs" ] && sha256sum < "$X/network/challenge-front-declaration.mjs" | cut -c1-12 || echo absent)"
  for t in $(for i in $INST; do echo installed-$i; done) $OWN; do
    ( cd "$X" && timeout 300 node --test --test-concurrency=1 --test-reporter=tap "test/$t.test.mjs" ) > "$B/receipts/t1/$1-$t.tap" 2>&1; rc=$?
    echo "[$1] $t rc=$rc $(grep -E '^# (pass|fail|skipped|cancelled) ' "$B/receipts/t1/$1-$t.tap" | tr '\n' ' ')"
    grep -E '^not ok' "$B/receipts/t1/$1-$t.tap" | head -12 | sed "s/^/[$1]   /"
  done; }
mkdir -p "$B/receipts/t1"
run V0
cp "$L/crh-merge3.mjs" "$X/network/challenge-replica-host.mjs"; want "$X/network/challenge-replica-host.mjs" "$(sha256sum < "$L/crh-merge3.mjs" | cut -c1-64)"
cp "$R2/network/enclave-network-host.mjs" "$X/network/enclave-network-host.mjs"
cp "$R2/network/challenge-front-declaration.mjs" "$X/network/challenge-front-declaration.mjs"
run V1
rm -rf "$X"
n=$(grep -vc " -V stub-proof$" "$B/stub/invocations.log" || true); [ "$n" -eq 0 ] || { echo "stub invoked $n times"; exit 5; }
echo T1-DONE

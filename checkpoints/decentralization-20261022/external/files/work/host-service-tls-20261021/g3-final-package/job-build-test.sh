#!/usr/bin/env bash
# G3 final package, job 1: rebuild the tree's role packages with the EXISTING builder, require --check, then targeted
# DNS+TLS tests only (no broad suite, no Rust). Loopback only; no network.
set -uo pipefail
G=/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021/g3-final-package; T=$G/tree; L=$G/logs
cd "$T"; date -u +%FT%TZ
node scripts/build-host-service-packages.mjs > $L/packages.out 2>&1; echo "packages rc=$?"
node scripts/build-host-service-packages.mjs --check > $L/packages-check.out 2>&1; echo "packages-check rc=$?"
sha256sum network/host-services/packages/*.package.json network/host-services/packages/*.mjs | cut -c1-16,65-
run() { local n=$1; shift; timeout 600 "$@" > $L/t-$n.out 2>&1; local rc=$?; echo "$n rc=$rc $(grep -E '^# (pass|fail)' $L/t-$n.out | tr '\n' ' ') $(grep '^not ok' $L/t-$n.out | cut -c1-90 | tr '\n' '|')"; }
run service-tls node --test --test-timeout=300000 test/service-tls.test.mjs
run a5-challenge-txt env A5_TREE=$T node --test --test-timeout=120000 test/challenge-txt-upstream.test.mjs
run dns-read-only env ENCLAVE_DNS_BIN=$T/relay/dns-relay.js node --test --test-timeout=300000 test/dns-read-only.test.mjs
for t in hosted-service-placement host-services-registry-id hosted-services-appstatic host-service-transport host-service-dns-publication; do
  [ -f test/$t.test.mjs ] && run $t node --test --test-timeout=300000 test/$t.test.mjs
done
date -u +%FT%TZ

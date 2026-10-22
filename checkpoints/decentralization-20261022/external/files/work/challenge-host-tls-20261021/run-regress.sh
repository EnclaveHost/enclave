#!/bin/bash
# usage: run-regress.sh <tree dir> <out> r1|r2   (existing suites that import a changed module; serial)
t=$1; out=$2; set=$3
R1="test/host-service-transport.test.mjs test/host-service-dns-publication.test.mjs test/host-service-ingress.test.mjs test/host-services-registry-id.test.mjs test/hosted-services-appstatic.test.mjs test/wg-provider.test.mjs test/wg-provider-dns-kernel.test.mjs test/privacy-agent-host-services-start.test.mjs test/host-service-replica-peers.test.mjs test/route-dns-transport-rate.test.mjs"
R2="test/enclave-network-host-canary.test.mjs test/independent-name-routing.test.mjs test/provider-canary-independent.test.mjs test/hosted-services-stage.test.mjs test/host-service-cold-bootstrap.test.mjs test/service-index.test.mjs test/network-authority-pins.test.mjs test/privacy-agent-lifecycle.test.mjs"
files=$R1; [ "$set" = r2 ] && files=$R2
cd "$t" || exit 9
if [ "$set" = r3 ]; then node --test --test-concurrency=1 --test-name-pattern='^(?!end to end)' test/challenge-replica-host.test.mjs > "$out" 2>&1; echo "exit=$?" >> "$out"; exit 0; fi
node --test --test-concurrency=1 $files > "$out" 2>&1; echo "exit=$?" >> "$out"

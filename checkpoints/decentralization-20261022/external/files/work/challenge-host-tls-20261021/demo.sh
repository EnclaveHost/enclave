#!/bin/bash
D="$(cd "$(dirname "$0")" && pwd)"; cd "$D"; B=../host-service-tls-20261021/g3-final-package/candidate/host-services.json
node propose-config.mjs --base $B --out proposal-fixture/out > proposal.out 2>&1; echo "exit=$? (expected 3: no manifest)" >> proposal.out
node propose-config.mjs --base $B --release-manifest proposal-fixture/FIXTURE-dns.mjs.manifest.json --out proposal-fixture/out >> proposal.out 2>&1; echo "exit=$?" >> proposal.out

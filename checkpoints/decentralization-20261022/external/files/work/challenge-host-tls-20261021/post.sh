#!/bin/bash
# One serial queue job after the mutants: regression r1/r2/r3, bundle reach, package --check (no write), config proposal demo
D="$(cd "$(dirname "$0")" && pwd)"; cd "$D"
./run-regress.sh "$D/tree" "$D/regress-r1.out" r1
./run-regress.sh "$D/tree" "$D/regress-r2.out" r2
./run-regress.sh "$D/tree" "$D/regress-r3.out" r3
node analyze-bundles.mjs > bundles.out 2>&1; echo "exit=$?" >> bundles.out
(cd tree && node scripts/build-host-service-packages.mjs --check) > packages-check.out 2>&1; echo "exit=$?" >> packages-check.out
mkdir -p proposal-fixture
printf '{"sha256":"%s","runtimeBundleSha256":"%s","note":"FIXTURE PINS for a validation demo only; not a release"}\n' "$(printf 'd%.0s' $(seq 64))" "$(printf 'e%.0s' $(seq 64))" > proposal-fixture/FIXTURE-dns.mjs.manifest.json
node propose-config.mjs --base ../host-service-tls-20261021/g3-final-package/candidate/host-services.json --out proposal-fixture/out > proposal.out 2>&1; echo "exit=$? (expected 3: no manifest)" >> proposal.out
node propose-config.mjs --base ../host-service-tls-20261021/g3-final-package/candidate/host-services.json --release-manifest proposal-fixture/FIXTURE-dns.mjs.manifest.json --out proposal-fixture/out >> proposal.out 2>&1; echo "exit=$?" >> proposal.out

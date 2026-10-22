#!/usr/bin/env bash
# compose5 = compose4 + canonical public-directory 95edf767 + the two same-route tests. Targeted tests, package rebuild,
# the same stage recipe (build-stage-r2.mjs, app-static fa9ac1fc, supervisor 42be59ff), then the bundle from the LIVE r3 base.
set -uo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work; H=$W/host-service-tls-20261021; A=$W/hosted-services-activation; C=$H/compose5
cd "$C"
for t in route-same-route-churn route-resign-admin-ban public-directory route-partial-qualification; do
  timeout 600 node --test --test-timeout=300000 "test/$t.test.mjs" > "$H/logs/c5-$t.out" 2>&1; rc=$?
  echo "$t rc=$rc $(grep -E '^# (pass|fail|skipped)' "$H/logs/c5-$t.out" | tr '\n' ' ') $(grep '^not ok' "$H/logs/c5-$t.out" | cut -c1-80 | tr '\n' '|')"
done
node scripts/build-host-service-packages.mjs > "$H/logs/r5-packages.out" 2>&1; echo "packages rc=$?"
node scripts/build-host-service-packages.mjs --check > "$H/logs/r5-packages-check.out" 2>&1; echo "packages-check rc=$?"
cd "$A" && node build-stage-r2.mjs --tree "$C" --app-static capture/app-static.json --out "$H/stage-r5" > "$H/logs/r5-stage.out" 2>&1; echo "stage rc=$?"
python3 "$H/upgrade/make-upgrade-bundle.py" --old-stage "$A/final-r3/stage-r2/enclave-host-services-hs2-windows" \
  --new-stage "$H/stage-r5/stage-r2/enclave-host-services-hs2-windows" --old-config "$H/bundle-input/host-services.r3-reconstructed.json" \
  --old-config-sha bef2446a14750871e3a696fe9c317ac930b8f0f8c7246efd393a8f0206946124 --old-receipt-sha d828b3b888ccf7c2a062c58eda7980531d6344592e4ce3eeea5dc86c46b13508 \
  --out "$H/upgrade-bundle-r5" > "$H/logs/r5-bundle.out" 2>&1; echo "bundle rc=$?"

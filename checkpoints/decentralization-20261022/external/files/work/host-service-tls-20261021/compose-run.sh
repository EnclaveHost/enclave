#!/usr/bin/env bash
# The ONE root-approved 768 job (16:04:35Z approval): the COMPOSITION main + e49 patch 0d244d73 + G3 patch, targeted.
set -uo pipefail
C=/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021/compose
L=/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021/logs
cd "$C"
node scripts/build-host-service-packages.mjs > "$L/c-build.out" 2>&1; echo "build rc=$?"
node scripts/build-host-service-packages.mjs --check > "$L/c-check.out" 2>&1; echo "check rc=$?"
sha256sum network/host-services/packages/*.package.json > "$L/c-packages.sha256"
for t in service-tls host-service-transport hosted-services-appstatic hosted-service-placement; do
  SERVICE_TLS_TMP=$L node --test --test-timeout=600000 "test/$t.test.mjs" > "$L/c-$t.out" 2>&1; rc=$?
  echo "$t rc=$rc $(grep -E '^# (pass|fail|skipped)' "$L/c-$t.out" | tr '\n' ' ')"
done

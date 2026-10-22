#!/usr/bin/env bash
# Targeted suites on compose4 = canonical (route 9ba9f6d3, public-directory 4a45) + e49 rev4 d1490809 + G3/B7 22a6c794.
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021; cd "$H/compose4"
for t in host-services-registry-id service-tls host-service-transport host-service-dns-publication hosted-services-appstatic route-partial-qualification public-directory privacy-agent-host-services-start route-dns-transport-rate wg-provider-host-services; do
  SERVICE_TLS_TMP=$H/logs timeout 900 node --test --test-timeout=300000 "test/$t.test.mjs" > "$H/logs/c4-$t.out" 2>&1; rc=$?
  echo "$t rc=$rc $(grep -E '^# (pass|fail|skipped)' "$H/logs/c4-$t.out" | tr '\n' ' ') $(grep '^not ok' "$H/logs/c4-$t.out" | cut -c1-80 | tr '\n' '|')"
done

#!/usr/bin/env bash
# Targeted suites on compose3 = current main (incl. root-integrated route-record 9ba9f6d3) + e49 rev2 68c7346e + G3/B7 patch 22a6c794.
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021; cd "$H/compose3"
for t in host-services-registry-id service-tls host-service-dns-publication hosted-services-appstatic; do
  SERVICE_TLS_TMP=$H/logs node --test --test-timeout=300000 "test/$t.test.mjs" > "$H/logs/c3-$t.out" 2>&1; rc=$?
  echo "$t rc=$rc $(grep -E '^# (pass|fail|skipped)' "$H/logs/c3-$t.out" | tr '\n' ' ') $(grep '^not ok' "$H/logs/c3-$t.out" | cut -c1-80 | tr '\n' '|')"
done

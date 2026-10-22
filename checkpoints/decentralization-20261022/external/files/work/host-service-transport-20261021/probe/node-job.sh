#!/bin/bash
# Node suites for host-service transport, on the isolated tree (queue 512): the new suites, then the existing suites of every
# touched module. --test-concurrency=2 bounds memory (a run of 7 files in parallel peaked at 503 MiB).
set -uo pipefail
H=$(cd "$(dirname "$0")/.." && pwd)
cd "$H/tree"
export MAIN_KERNEL="$H/../enclave/network/wg-provider/kernel.mjs"
declare -A G
G[new]="test/wg-provider-host-services.test.mjs test/wg-provider-dns-kernel.test.mjs test/host-service-ingress.test.mjs test/host-service-transport.test.mjs test/host-service-dns-publication.test.mjs"
G[transport]="test/wg-provider.test.mjs test/wg-renewal.test.mjs test/transport-profile.test.mjs test/provider-bootstrap.test.mjs test/wg-manager.test.mjs test/windows-node-network-enroll.test.mjs test/privacy-agent-lifecycle.test.mjs"
G[dns]="test/dns-relay.test.mjs test/dns-read-only.test.mjs test/custody-endpoints.test.mjs test/hosted-services-appstatic.test.mjs test/hosted-services-stage.test.mjs test/hosted-service-placement.test.mjs"
ok=1
for g in new transport dns; do
  echo "== $g"
  node --test --test-concurrency=2 --test-timeout=120000 --test-reporter=tap ${G[$g]} > "$H/logs/node-$g.tap" 2>&1
  grep -E "^# (tests|pass|fail|skipped)" "$H/logs/node-$g.tap"; grep -E "^not ok" "$H/logs/node-$g.tap" | head -20
  grep -q "^# fail 0" "$H/logs/node-$g.tap" || ok=0
done
[ $ok = 1 ] && echo NODE-JOB-OK || { echo NODE-JOB-FAILED; exit 1; }

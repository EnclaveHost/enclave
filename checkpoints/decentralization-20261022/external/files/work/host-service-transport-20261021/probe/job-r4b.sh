#!/bin/bash
# rev4 (512): stage inventory (new enclave-wg.exe, provider bundle with the DNS gate), the route-dns transport + DNS/roles
# suites touched by dns-relay.js/roles.mjs/stage-tool.mjs, then the mutation suite.
set -uo pipefail
H=$(cd "$(dirname "$0")/.." && pwd); rc=0
echo "== stage inventory"; (cd "$H/tree" && node "$H/probe/stage-inventory.mjs") || rc=1
cd "$H/tree"
F="test/route-dns-transport-rate.test.mjs test/host-service-dns-publication.test.mjs test/hosted-services-appstatic.test.mjs test/hosted-services-stage.test.mjs test/dns-relay.test.mjs test/dns-read-only.test.mjs test/custody-endpoints.test.mjs"
node --test --test-concurrency=2 --test-timeout=120000 --test-reporter=tap $F > "$H/logs/r4b.tap" 2>&1
grep -E "^# (tests|pass|fail|skipped)|^not ok" "$H/logs/r4b.tap"; grep -q "^# fail 0" "$H/logs/r4b.tap" || rc=1
echo "== mutation"; python3 "$H/probe/mutate.py" || rc=1
echo "JOB-R4B-RC=$rc"; exit $rc

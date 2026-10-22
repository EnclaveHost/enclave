#!/bin/bash
# Re-run after the agent fix (normalized hostServices re-validated; host services never take the agent down): stage
# inventory (privacy-agent bundle changed), the new Node group incl. the real-daemon startup test, the lifecycle suite, the
# mutation suite. Not repeated (unchanged since the 17:02:58Z job): the other transport suites, native-g2 scaffold.
set -uo pipefail
H=$(cd "$(dirname "$0")/.." && pwd); rc=0
echo "== stage inventory"; (cd "$H/tree" && node "$H/probe/stage-inventory.mjs") || rc=1
cd "$H/tree"; export MAIN_KERNEL="$H/../enclave/network/wg-provider/kernel.mjs"
F="test/wg-provider-host-services.test.mjs test/wg-provider-dns-kernel.test.mjs test/host-service-ingress.test.mjs test/host-service-transport.test.mjs test/host-service-dns-publication.test.mjs test/host-service-cold-bootstrap.test.mjs test/host-service-replica-peers.test.mjs test/privacy-agent-host-services-start.test.mjs test/privacy-agent-lifecycle.test.mjs"
node --test --test-concurrency=2 --test-timeout=120000 --test-reporter=tap $F > "$H/logs/prereq2.tap" 2>&1
grep -E "^# (tests|pass|fail|skipped)|^not ok" "$H/logs/prereq2.tap"; grep -q "^# fail 0" "$H/logs/prereq2.tap" || rc=1
echo "== mutation"; python3 "$H/probe/mutate.py" || rc=1
echo "JOB-PREREQ2-RC=$rc"; exit $rc

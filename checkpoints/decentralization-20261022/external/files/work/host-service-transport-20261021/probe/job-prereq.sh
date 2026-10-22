#!/bin/bash
# ONE 512 job for the activation prerequisites: stage inventory (+ lone-worker and bundled --ruleset checks), the Node suites
# of the touched modules (new + transport groups), the mutation suite, then the native-g2 scaffold re-validation.
set -uo pipefail
H=$(cd "$(dirname "$0")/.." && pwd); rc=0
echo "== stage inventory"; (cd "$H/tree" && node "$H/probe/stage-inventory.mjs") || rc=1
cd "$H/tree"; export MAIN_KERNEL="$H/../enclave/network/wg-provider/kernel.mjs"
NEW="test/wg-provider-host-services.test.mjs test/wg-provider-dns-kernel.test.mjs test/host-service-ingress.test.mjs test/host-service-transport.test.mjs test/host-service-dns-publication.test.mjs test/host-service-cold-bootstrap.test.mjs test/host-service-replica-peers.test.mjs test/privacy-agent-host-services-start.test.mjs"
OLD="test/wg-provider.test.mjs test/wg-renewal.test.mjs test/transport-profile.test.mjs test/provider-bootstrap.test.mjs test/wg-manager.test.mjs test/windows-node-network-enroll.test.mjs test/privacy-agent-lifecycle.test.mjs"
for g in NEW OLD; do echo "== node $g"; node --test --test-concurrency=2 --test-timeout=120000 --test-reporter=tap ${!g} > "$H/logs/prereq-$g.tap" 2>&1
  grep -E "^# (tests|pass|fail|skipped)|^not ok" "$H/logs/prereq-$g.tap"; grep -q "^# fail 0" "$H/logs/prereq-$g.tap" || rc=1; done
echo "== mutation"; python3 "$H/probe/mutate.py" || rc=1
echo "== native-g2 scaffold"; bash "$H/native-g2/local-scaffold.sh" || rc=1
echo "JOB-PREREQ-RC=$rc"; exit $rc

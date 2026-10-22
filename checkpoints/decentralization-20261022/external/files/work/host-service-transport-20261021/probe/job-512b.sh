#!/bin/bash
# Re-run after the certificate-fixture fix (short CN, name in SAN): the new Node group, then the mutation suite.
set -uo pipefail
H=$(cd "$(dirname "$0")/.." && pwd); cd "$H/tree"; rc=0
export MAIN_KERNEL="$H/../enclave/network/wg-provider/kernel.mjs"
F="test/wg-provider-host-services.test.mjs test/wg-provider-dns-kernel.test.mjs test/host-service-ingress.test.mjs test/host-service-transport.test.mjs test/host-service-dns-publication.test.mjs test/host-service-cold-bootstrap.test.mjs"
node --test --test-concurrency=2 --test-timeout=120000 --test-reporter=tap $F > "$H/logs/final2-new.tap" 2>&1
grep -E "^# (tests|pass|fail|skipped)|^not ok" "$H/logs/final2-new.tap"; grep -q "^# fail 0" "$H/logs/final2-new.tap" || rc=1
echo "== mutation"; python3 "$H/probe/mutate.py" || rc=1
echo "JOB-512B-RC=$rc"; exit $rc

#!/bin/bash
# rev4 G2 readiness (512): the kernel suites (gate + pending delete), the mutation suite, then the native-g2 freeze,
# manifest and scaffold re-validation.
set -uo pipefail
H=$(cd "$(dirname "$0")/.." && pwd); rc=0; cd "$H/tree"; export MAIN_KERNEL="$H/../enclave/network/wg-provider/kernel.mjs"
node --test --test-concurrency=2 --test-reporter=tap test/wg-provider-dns-kernel.test.mjs test/wg-provider-host-services.test.mjs test/wg-provider.test.mjs test/transport-profile.test.mjs > "$H/logs/g2r4.tap" 2>&1
grep -E "^# (tests|pass|fail|skipped)|^not ok" "$H/logs/g2r4.tap"; grep -q "^# fail 0" "$H/logs/g2r4.tap" || rc=1
echo "== mutation"; python3 "$H/probe/mutate.py" || rc=1
echo "== native-g2 freeze + scaffold"; bash "$H/native-g2/local-scaffold.sh" || rc=1
echo "JOB-G2R4-RC=$rc"; exit $rc

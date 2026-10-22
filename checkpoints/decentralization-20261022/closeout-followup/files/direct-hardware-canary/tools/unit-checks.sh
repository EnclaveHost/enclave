#!/usr/bin/env bash
# unit-checks (queue 256): ONLY the canary's own narrow tests. No QEMU, no production PID signalled, no network.
#   1. test/canary-launcher.test.mjs - the published launcher's dry run (fake QEMU), wrapper refusals, acceptance rules, owner config
#   2. test/test_run_canary.py      - accept(), no-key evidence, argv checks, pins, ownership-bound cleanup, parent supervise()
set -uo pipefail
. "$(dirname "$0")/env.sh"
export TMPDIR=$D/tmp
cd "$D"; rc=0
node --test --test-concurrency=1 test/canary-launcher.test.mjs > "$D/rawlogs/unit-node.tap" 2>&1 || rc=1
grep -E "^# (tests|pass|fail|skipped|cancelled) |^not ok" "$D/rawlogs/unit-node.tap"
python3 -u test/test_run_canary.py > "$D/rawlogs/unit-python.log" 2>&1 || rc=1
grep -E "^Ran |^OK|^FAILED|ERROR:|FAIL:" "$D/rawlogs/unit-python.log"
rm -rf "$D/canary/__pycache__" "$D/test/__pycache__"
n=$(( $(wc -l < "$D/logs/ssh-stub-invocations.log") - STUB_BASE )); echo "ssh stub invocations during the tests: $n"; [ "$n" -eq 0 ] || rc=1
for p in 3483499 3817658; do echo "protected $p starttime $(awk '{print $22}' /proc/$p/stat 2>/dev/null)"; done
echo "UNIT rc=$rc"; exit $rc

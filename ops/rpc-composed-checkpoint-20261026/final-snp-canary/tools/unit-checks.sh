#!/usr/bin/env bash
# unit-checks (queue 512): ONLY the canary's own narrow tests. No QEMU, no production PID signalled, no network.
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
python3 - "$D/rawlogs/unit-node.tap" "$D/rawlogs/unit-python.log" <<'PY' || rc=1
import pathlib, re, sys
tap, py = (pathlib.Path(p).read_text() for p in sys.argv[1:])
counts = {k: int(v) for k, v in re.findall(r'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$', tap, re.M)}
assert counts == {'tests': 6, 'pass': 6, 'fail': 0, 'cancelled': 0, 'skipped': 0, 'todo': 0}, counts
assert re.search(r'^Ran 21 tests in [0-9.]+s$', py, re.M), py[-1000:]
assert re.search(r'^OK$', py, re.M) and not re.search(r'skipped|expected failure|unexpected success', py), py[-1000:]
print('Strict canary unit receipts: 6 Node + 21 Python passed, no skips')
PY
rm -rf "$D/canary/__pycache__" "$D/test/__pycache__"
n=$(( $(wc -l < "$D/logs/ssh-stub-invocations.log") - STUB_BASE )); echo "ssh stub invocations during the tests: $n"; [ "$n" -eq 0 ] || rc=1
for p in $(pgrep -x qemu-system-x86); do echo "qemu $p starttime $(awk "{print \$22}" /proc/$p/stat 2>/dev/null)"; done
echo "UNIT rc=$rc"; exit $rc

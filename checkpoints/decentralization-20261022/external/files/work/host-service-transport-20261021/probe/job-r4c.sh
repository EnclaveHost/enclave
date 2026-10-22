#!/bin/bash
# rev4: the reordered P3 test and its three mutants only (everything else unchanged since job-r4b).
set -uo pipefail
H=$(cd "$(dirname "$0")/.." && pwd); rc=0; cd "$H/tree"
node --test --test-reporter=tap test/route-dns-transport-rate.test.mjs > "$H/logs/r4c.tap" 2>&1
grep -E "^# (tests|pass|fail)|^not ok" "$H/logs/r4c.tap"; grep -q "^# fail 0" "$H/logs/r4c.tap" || rc=1
ONLY_P3=1 python3 "$H/probe/mutate.py" || rc=1
echo "JOB-R4C-RC=$rc"; exit $rc

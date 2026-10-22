#!/bin/bash
# targeted re-run after the G-UPD fix: only the existing tests whose path crosses the pins updater read or BeforeStop
set -uo pipefail; cd "$(dirname "$0")/.."; rc=0
python3 tools/cutover-mock-test.py -v Cutover.test_update_task_running_or_due_refuses_and_changes_nothing Cutover.test_update_task_ready_and_not_due_is_recorded_and_passes LeaseDeadline.test_exact_need_passes_and_is_journaled LeaseDeadline.test_short_lease_refuses_at_the_pins > targeted-existing.out 2>&1 || rc=1
python3 tools/preparation-test.py -v > targeted-preparation.out 2>&1 || rc=1
python3 tools/recovery-floor-test.py -v > targeted-floor.out 2>&1 || rc=1
for f in targeted-existing.out targeted-preparation.out targeted-floor.out; do echo "== $f"; grep -E "^Ran|^OK|FAILED" "$f"; done; echo "RC=$rc"; exit $rc

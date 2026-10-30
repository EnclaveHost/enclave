#!/bin/bash
# composite-mdbx-validation-stage/r6 PRODUCTION diagnostic: DISABLED in r6 (prepared by Claude 1785/1787). It refuses unconditionally.
# Enabling needs a NEW reviewed revision after ALL of: an actual cmv-r6-tests PASS; recovery-multipart r3 status with all 265 parts
# committed + verified in CONFIRMED sessions; an r6 PRODUCTION view (root-view-import.sh, recheck OK); a memory/time window.
# The intended invocation (documented only; 2560 is a cap claude-test-queue.py supports - a placeholder for root, not a measurement):
#   bash jobs/q-exit-status.sh cmv-prod 2560 bash composite-mdbx-validation-stage/rN/jobs/root-composite-validate.sh VIEW_DIR [TIMEOUT]
#   ... python3 -I -B composite_session.py --view-dir VIEW_DIR --run-dir NEW_RUN_DIR --expect-kind production --validator-timeout T
# Stop: jobs/stop-session.sh RUN_DIR (the recorded session PID only; never signal the queue or any other process).
echo "## REFUSED: production composite validation is DISABLED in r6 (see the header)"; exit 9

#!/bin/sh
# (immutable; v1) gate v4 narrow tests: the new selection/gate test, then the unchanged v3 test against the v4 gate
# (strict health/journal/staleness/window behaviour must be unchanged).
set -e
cd "$(dirname "$0")"
python3 activation/test-gate-v4.py
python3 activation/test-gate-v3.py
echo RUN-GATE-V4-OK

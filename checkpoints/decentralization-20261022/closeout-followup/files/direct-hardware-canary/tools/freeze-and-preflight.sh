#!/usr/bin/env bash
# freeze-and-preflight (queue 256): FROZEN-PINS.json from the final source, then run-canary.py --preflight (read-only: hashes and
# host state only - no lock, no run directory, no launcher, no QEMU).
set -uo pipefail
. "$(dirname "$0")/env.sh"
cd "$D"
python3 tools/freeze.py "$@" || exit 1
python3 canary/run-canary.py --preflight; rc=$?
rm -rf "$D/canary/__pycache__"
echo "stub invocations: $(( $(wc -l < "$D/logs/ssh-stub-invocations.log") - STUB_BASE ))"
exit $rc

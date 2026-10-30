#!/bin/bash
# base-launch-producer-stage tests (ROOT runs them; Claude did not). Offline (no network; the harness fixture uses node + the
# vendored anchor module only), queue 256, foreground:
#   S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-launch-producer-stage
#   python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log $S/logs/root-producer-tests.guard -- unshare -rn bash $S/jobs/root-producer-tests.sh
# Pins: this stage's MANIFEST.sha256 and the consumed inputs (A2-A4 stage a2a4.py + its test fixture module, the wrapper
# candidate and its stage manifest). Pass = rc 0, a bare final "OK", no skips / expected failures.
set -uo pipefail
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-launch-producer-stage
ip link set lo up 2>/dev/null || true
(cd "$S" && sha256sum -c --quiet MANIFEST.sha256) || { echo "## HARNESS: stage files changed"; exit 2; }
sha256sum -c --quiet "$S/inputs/consumed-inputs.sha256" || { echo "## HARNESS: consumed inputs changed"; exit 2; }
export ANCHOR_DEPS_ROOT=${ANCHOR_DEPS_ROOT:-/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/relay-consumer-source}
OUT=$S/logs/root-producer-tests-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$OUT" || exit 2
(cd "$S" && timeout 1800 python3 -u tests/test_base_launch.py) < /dev/null > "$OUT/test_base_launch.log" 2>&1; r=$?
last=$(grep -E '^(OK|FAILED)' "$OUT/test_base_launch.log" | tail -1)
if [ $r = 0 ] && [ "$last" = OK ] && ! grep -qE '^(OK|FAILED) \(' "$OUT/test_base_launch.log"; then echo "PASS test_base_launch $(grep -oE '^Ran [0-9]+ tests' "$OUT/test_base_launch.log")"; rc=0; else echo "FAIL rc=$r '$last'"; tail -30 "$OUT/test_base_launch.log"; rc=1; fi
echo "## logs: $OUT"; echo "## aggregate rc=$rc"; exit $rc

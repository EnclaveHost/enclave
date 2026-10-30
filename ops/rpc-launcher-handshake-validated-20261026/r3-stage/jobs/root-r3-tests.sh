#!/bin/bash
# base-launch-producer-stage/r3 tests (ROOT runs them; Claude did not). Local, offline (no network; the harness fixture uses
# node + the vendored anchor module only), no client, no guest, queue 256, foreground:
#   S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-launch-producer-stage/r3
#   python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log $S/logs/root-r3-tests.guard -- unshare -rn bash $S/jobs/root-r3-tests.sh
# Suites and EXACT counts. PASS for a suite requires all of: rc 0, a final line exactly "OK", "Ran <n> tests" == n, and no
# skip / expected failure / unexpected success:
#   baseline-existing  base-wrapper-integration-stage/base (production wrapper 75c879ec) + test_chain_service.py      34
#   r3-existing        r3/wrapper (== r2 wrapper 07276ec8) + test_chain_service.py (byte-identical 541342a4)           34
#   r3-launcher        r3/tests/test_r3_launcher.py                                                                  27
#                      (ProduceRefusals 9, ReleaseSelection 2, LaunchBinding 2, Handshake 11, DropPrivileges 3)
# Aggregate PASS = all three PASS and rc 0. Any other outcome is FAIL. Queue exit 98 = not started.
# NOT run, intentionally: the r1 lifecycle suites (wrapper test_chain_service_release.py 14, producer test_base_launch.py 13)
# and r2's test_r2_handshake.py (superseded; its run root-r2-tests-20261026T014740Z stays in r2/logs).
set -uo pipefail
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-launch-producer-stage/r3
WI=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-wrapper-integration-stage
ip link set lo up 2>/dev/null || true
(cd "$S" && sha256sum -c --quiet MANIFEST.sha256) || { echo "## HARNESS: r3 stage files changed"; exit 2; }
sha256sum -c --quiet "$S/inputs/consumed-inputs.sha256" || { echo "## HARNESS: consumed inputs changed"; exit 2; }
[ -z "${ENCLAVE_BASE_LAUNCH_HANDSHAKE+x}" ] || { echo "## HARNESS: the unit drop-in marker must not be set for tests"; exit 2; }
export ANCHOR_DEPS_ROOT=${ANCHOR_DEPS_ROOT:-/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/relay-consumer-source}
OUT=$S/logs/root-r3-tests-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$OUT" || exit 2
rc=0
check() { local label=$1 want=$2 r=$3 f="$OUT/$1.out"
  local ran=$(grep -oE '^Ran [0-9]+ tests?' "$f" | tail -1 | grep -oE '[0-9]+')
  local last=$(grep -E '^(OK|FAILED)' "$f" | tail -1)
  if [ "$r" = 0 ] && [ "$last" = OK ] && [ "$ran" = "$want" ] && ! grep -qE 'skipped|expected failure|unexpected success' "$f"; then
    echo "PASS $label Ran $ran (expected $want)"
  else echo "FAIL $label rc=$r ran=${ran:-none} expected=$want last='$last'"; tail -60 "$f"; rc=1; fi; }
(cd "$WI/base" && timeout 300 python3 -E -s -m unittest -v test_chain_service) < /dev/null > "$OUT/baseline-existing.out" 2>&1; check baseline-existing 34 $?
(cd "$S/wrapper" && timeout 300 python3 -E -s -m unittest -v test_chain_service) < /dev/null > "$OUT/r3-existing.out" 2>&1; check r3-existing 34 $?
(cd "$S" && timeout 2400 python3 -E -s -u tests/test_r3_launcher.py) < /dev/null > "$OUT/r3-launcher.out" 2>&1; check r3-launcher 27 $?
echo "## logs: $OUT"; echo "## aggregate rc=$rc"; exit $rc

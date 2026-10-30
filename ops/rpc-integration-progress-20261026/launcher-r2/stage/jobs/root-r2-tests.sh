#!/bin/bash
# base-launch-producer-stage/r2 tests (ROOT runs them; Claude did not). Local, offline (no network; the harness fixture uses node +
# the vendored anchor module only), no client, no guest, queue 256, foreground:
#   S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-launch-producer-stage/r2
#   python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log $S/logs/root-r2-tests.guard -- unshare -rn bash $S/jobs/root-r2-tests.sh
# Suites and EXACT expected counts (each: rc 0, final line exactly "OK", "Ran <n> tests" equal to the expectation, no skip /
# expected failure / unexpected success):
#   baseline-existing  base-wrapper-integration-stage/base (production wrapper 75c879ec) test_chain_service.py   34
#   r2-existing        r2/wrapper (r2 wrapper)  test_chain_service.py (byte-identical copy, 541342a4)          34
#   r2-handshake       r2/tests/test_r2_handshake.py (real run('base') path, crashes, concurrency, producer)  15
# NOT run here, intentionally: the r1 lifecycle suites (wrapper test_chain_service_release.py 14, producer test_base_launch.py
# 13). They test lifecycle.json / mark-started semantics that r2 removes; they still pin their unchanged r1 stages.
set -uo pipefail
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-launch-producer-stage/r2
WI=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-wrapper-integration-stage
ip link set lo up 2>/dev/null || true
(cd "$S" && sha256sum -c --quiet MANIFEST.sha256) || { echo "## HARNESS: r2 stage files changed"; exit 2; }
sha256sum -c --quiet "$S/inputs/consumed-inputs.sha256" || { echo "## HARNESS: consumed inputs changed"; exit 2; }
[ -z "${ENCLAVE_BASE_LAUNCH_HANDSHAKE+x}" ] || { echo "## HARNESS: the unit drop-in marker must not be set for tests"; exit 2; }
export ANCHOR_DEPS_ROOT=${ANCHOR_DEPS_ROOT:-/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/relay-consumer-source}
OUT=$S/logs/root-r2-tests-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$OUT" || exit 2
rc=0
check() { local label=$1 want=$2 r=$3 f="$OUT/$1.out"
  local ran=$(grep -oE '^Ran [0-9]+ tests?' "$f" | tail -1 | grep -oE '[0-9]+')
  local last=$(grep -E '^(OK|FAILED)' "$f" | tail -1)
  if [ "$r" = 0 ] && [ "$last" = OK ] && [ "$ran" = "$want" ] && ! grep -qE 'skipped|expected failure|unexpected success' "$f"; then
    echo "PASS $label Ran $ran (expected $want)"
  else echo "FAIL $label rc=$r ran=${ran:-none} expected=$want last='$last'"; tail -40 "$f"; rc=1; fi; }
(cd "$WI/base" && timeout 300 python3 -E -s -m unittest -v test_chain_service) < /dev/null > "$OUT/baseline-existing.out" 2>&1; check baseline-existing 34 $?
(cd "$S/wrapper" && timeout 300 python3 -E -s -m unittest -v test_chain_service) < /dev/null > "$OUT/r2-existing.out" 2>&1; check r2-existing 34 $?
(cd "$S" && timeout 1800 python3 -E -s -u tests/test_r2_handshake.py) < /dev/null > "$OUT/r2-handshake.out" 2>&1; check r2-handshake 15 $?
echo "## logs: $OUT"; echo "## aggregate rc=$rc"; exit $rc

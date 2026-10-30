#!/bin/bash
# base-reanchor-recovery-stage/r2 tests (ROOT runs them; Claude did not). Local, offline (no network; the harness fixture uses node +
# the vendored anchor module only), no client, no guest, queue 256, foreground:
#   S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-reanchor-recovery-stage/r2
#   python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log $S/logs/root-reanchor-r2-tests.guard -- unshare -rn bash $S/jobs/root-reanchor-r2-tests.sh
# Suites and EXACT counts. PASS for a suite requires all of: rc 0, a final line exactly "OK", "Ran <n> tests" == n, and no
# skip / expected failure / unexpected success:
#   baseline-existing    base-wrapper-integration-stage/base (production wrapper 75c879ec) + test_chain_service.py         34
#   recovery-existing    this stage's wrapper copy + test_chain_service.py (byte-identical 541342a4)                    34
#   r3-regression        tests/test_r3_launcher.py (byte-identical r3 suite) over this stage's wrapper + producer copies 27
#                        (the first-bootstrap path, the reviewed harness abe223d6)
#   reanchor-recovery    tests/test_reanchor_recovery.py (r2: 7 adapted r1 + 6 watermark/crash/gate_download)            13
# Aggregate PASS = all four PASS and rc 0. Any other outcome is FAIL. Queue exit 98 = not started.
set -uo pipefail
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-reanchor-recovery-stage/r2
WI=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-wrapper-integration-stage
ip link set lo up 2>/dev/null || true
(cd "$S" && sha256sum -c --quiet MANIFEST.sha256) || { echo "## HARNESS: stage files changed"; exit 2; }
sha256sum -c --quiet "$S/inputs/consumed-inputs.sha256" || { echo "## HARNESS: consumed inputs changed"; exit 2; }
[ -z "${ENCLAVE_BASE_LAUNCH_HANDSHAKE+x}" ] || { echo "## HARNESS: the unit drop-in marker must not be set for tests"; exit 2; }
[ ! -e /etc/enclave-rpc/base-bootstrap-archive ] && [ ! -e /etc/enclave-rpc/base-finality-watermark ] || { echo "## HARNESS: a real launch archive exists on this host; the r3 regression uses the default path"; exit 2; }
export ANCHOR_DEPS_ROOT=${ANCHOR_DEPS_ROOT:-/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/relay-consumer-source}
OUT=$S/logs/root-reanchor-r2-tests-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$OUT" || exit 2
rc=0
check() { local label=$1 want=$2 r=$3 f="$OUT/$1.out"
  local ran=$(grep -oE '^Ran [0-9]+ tests?' "$f" | tail -1 | grep -oE '[0-9]+')
  local last=$(grep -E '^(OK|FAILED)' "$f" | tail -1)
  if [ "$r" = 0 ] && [ "$last" = OK ] && [ "$ran" = "$want" ] && ! grep -qE 'skipped|expected failure|unexpected success' "$f"; then
    echo "PASS $label Ran $ran (expected $want)"
  else echo "FAIL $label rc=$r ran=${ran:-none} expected=$want last='$last'"; tail -60 "$f"; rc=1; fi; }
(cd "$WI/base" && timeout 300 python3 -E -s -m unittest -v test_chain_service) < /dev/null > "$OUT/baseline-existing.out" 2>&1; check baseline-existing 34 $?
(cd "$S/wrapper" && timeout 300 python3 -E -s -m unittest -v test_chain_service) < /dev/null > "$OUT/recovery-existing.out" 2>&1; check recovery-existing 34 $?
(cd "$S" && timeout 2400 python3 -E -s -u tests/test_r3_launcher.py) < /dev/null > "$OUT/r3-regression.out" 2>&1; check r3-regression 27 $?
(cd "$S" && timeout 2400 python3 -E -s -u tests/test_reanchor_recovery.py) < /dev/null > "$OUT/reanchor-recovery.out" 2>&1; check reanchor-recovery 13 $?
echo "## logs: $OUT"; echo "## aggregate rc=$rc"; exit $rc

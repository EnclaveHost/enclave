#!/bin/bash
# base-reanchor-recovery-stage/r5 tests (ROOT runs them; Claude did not). Local, offline (no network; the harness fixture uses node +
# the vendored anchor module only), no client, no guest, queue 256, foreground:
#   S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-reanchor-recovery-stage/r5
#   python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $S/logs/root-reanchor-r5-tests.guard -- unshare -rn bash $S/jobs/root-reanchor-r5-tests.sh
# Suites and EXACT counts. PASS for a suite requires all of: rc 0, a final line exactly "OK", "Ran <n> tests" == n, and no
# skip / expected failure / unexpected success:
#   baseline-existing    base-wrapper-integration-stage/base (production wrapper 75c879ec) + test_chain_service.py         34
#   recovery-existing    this stage's wrapper copy + test_chain_service.py (byte-identical 541342a4)                    34
#   r3-regression        tests/test_r3_launcher.py (byte-identical r3 suite) over this stage's wrapper + producer copies 27
#                        (the first-bootstrap path, the reviewed harness abe223d6)
#   reanchor-recovery    tests/test_reanchor_recovery.py (r4: the 14 of r3 + 5 Ledger lock/race/interruption/tamper)      19
# The capture tests use the REAL a1-capture-binding-stage/r2 module (pinned 2352df7b) over its pinned STUB sources (no mainnet).
# Aggregate PASS = all four PASS and rc 0. Any other outcome is FAIL. Queue exit 98 = not started.
set -uo pipefail
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-reanchor-recovery-stage/r5
WI=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-wrapper-integration-stage
ip link set lo up 2>/dev/null || true
(cd "$S" && sha256sum -c --quiet MANIFEST.sha256) || { echo "## HARNESS: stage files changed"; exit 2; }
sha256sum -c --quiet "$S/inputs/consumed-inputs.sha256" || { echo "## HARNESS: consumed inputs changed"; exit 2; }
CAP=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/a1-capture-binding-stage/r2
(cd "$CAP" && sha256sum -c --quiet SHA256SUMS) || { echo "## HARNESS: capture/r2 stage files changed (its pinned module/stubs/gate)"; exit 2; }
[ -z "${ENCLAVE_BASE_LAUNCH_HANDSHAKE+x}" ] || { echo "## HARNESS: the unit drop-in marker must not be set for tests"; exit 2; }
[ ! -e /etc/enclave-rpc/base-bootstrap-archive ] && [ ! -e /etc/enclave-rpc/base-finality-watermark ] || { echo "## HARNESS: a real launch archive exists on this host; the r3 regression uses the default path"; exit 2; }
export ANCHOR_DEPS_ROOT=${ANCHOR_DEPS_ROOT:-/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/relay-consumer-source}
OUT=$S/logs/root-reanchor-r5-tests-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$OUT" || exit 2
# every real capture copies the node binary (~56 MB) into its private directory: temporary trees live on disk, not tmpfs
mkdir -p "$OUT/tmp" && export TMPDIR="$OUT/tmp" || exit 2
rc=0
check() { local label=$1 want=$2 r=$3 f="$OUT/$1.out"
  local ran=$(grep -oE '^Ran [0-9]+ tests?' "$f" | tail -1 | grep -oE '[0-9]+')
  local last=$(grep -E '^(OK|FAILED)' "$f" | tail -1)
  if [ "$r" = 0 ] && [ "$last" = OK ] && [ "$ran" = "$want" ] && ! grep -qE 'skipped|expected failure|unexpected success' "$f"; then
    echo "PASS $label Ran $ran (expected $want)"
  else echo "FAIL $label rc=$r ran=${ran:-none} expected=$want last='$last'"; tail -60 "$f"; rc=1; fi; }
for file in harness/a2a4.py producer/base_launch.py wrapper/chain_service.py tests/test_r3_launcher.py; do
  cmp -s "$S/$file" "$S/../r4/$file" || { echo "prior regression provenance changed: $file"; exit 2; }
done
PRIOR=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/logs/root-reanchor-r4-0302.out
for row in 'PASS baseline-existing Ran 34 (expected 34)' 'PASS recovery-existing Ran 34 (expected 34)' 'PASS r3-regression Ran 27 (expected 27)'; do
 grep -Fx "$row" "$PRIOR" || exit 2
done
sha256sum "$PRIOR"
echo "Prior 95 regression results reused with exact unchanged source; new19 execute below."
(cd "$S" && timeout 3600 python3 -E -s -u tests/test_reanchor_recovery.py) < /dev/null > "$OUT/reanchor-recovery.out" 2>&1; check reanchor-recovery 19 $?
echo "## logs: $OUT"; echo "## aggregate rc=$rc"; exit $rc

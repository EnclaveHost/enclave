#!/bin/bash
# base-reanchor-recovery-stage/r6 tests (ROOT runs them; Claude did not). Local, offline (no network; the harness fixture uses node +
# the vendored anchor module only), no client, no guest, queue 1024, foreground:
#   S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-reanchor-recovery-stage/r6
#   python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $S/logs/root-reanchor-r6-tests.guard -- unshare -rn bash $S/jobs/root-reanchor-r6-tests.sh > $S/logs/root-reanchor-r6-tests.out 2>&1; echo $? > $S/logs/root-reanchor-r6-tests.rc
# r6 changes PRODUCT pins vs r5 (harness A1_CAPTURE_SHA256 -> capture r4; producer RECOVERY_A2A4_SHA256 -> the new harness), so
# NO prior result is reused: the FULL integrated suite runs fresh. Suites and EXACT counts. PASS for a suite requires all of:
# rc 0, a final line exactly "OK", "Ran <n> tests" == n, and no skip / expected failure / unexpected success:
#   baseline-existing    base-wrapper-integration-stage/base (production wrapper) + test_chain_service.py              34
#   recovery-existing    this stage's wrapper copy + test_chain_service.py (byte-identical to r5)                      34
#   r3-regression        tests/test_r3_launcher.py (byte-identical r3 suite) over this stage's wrapper + producer copies 27
#   reanchor-recovery    tests/test_reanchor_recovery.py (r5's 19; capture tests use the REAL capture/r4 module)        19
# The reanchor suite runs as an ORDINARY caller (python3 -E -s, NO -B; PYTHONDONTWRITEBYTECODE/PYTHONPYCACHEPREFIX unset): the
# condition under which r5's 2 capture tests failed (code/__pycache__ in the capture). Real captures run; none is skipped.
# Aggregate PASS = all four PASS and rc 0. Any other outcome is FAIL. Queue exit 98 = not started.
set -uo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$P/base-reanchor-recovery-stage/r6
WI=$P/base-wrapper-integration-stage
CAP=$P/a1-capture-binding-stage/r4
ip link set lo up 2>/dev/null || true
(cd "$S" && sha256sum -c --quiet MANIFEST.sha256) || { echo "## HARNESS: stage files changed"; exit 2; }
sha256sum -c --quiet "$S/inputs/consumed-inputs.sha256" || { echo "## HARNESS: consumed inputs changed"; exit 2; }
(cd "$CAP" && sha256sum -c --quiet SHA256SUMS) || { echo "## HARNESS: capture/r4 stage files changed (its pinned module/stubs/gate)"; exit 2; }
capsha=$(sha256sum "$CAP/src/a1_capture.py" | cut -c1-64); hsha=$(sha256sum "$S/harness/a2a4.py" | cut -c1-64)
grep -qx "A1_CAPTURE_SHA256 = '$capsha'   # a1-capture-binding-stage/r4/src/a1_capture.py" "$S/harness/a2a4.py" || { echo "## HARNESS: harness capture pin != capture/r4 source"; exit 2; }
grep -q "^RECOVERY_A2A4_SHA256 = '$hsha'" "$S/producer/base_launch.py" || { echo "## HARNESS: producer harness pin != this stage's harness"; exit 2; }
grep -qx 'A1_CAPTURE_REVIEWED = False' "$S/harness/a2a4.py" || { echo "## HARNESS: capture HOLD flag is not False"; exit 2; }
grep -qx 'FINALITY_PROOF_REVIEWED = False' "$P/base-launch-producer-stage/r3/producer/base_launch.py" || { echo "## HARNESS: launcher r3 FINALITY_PROOF_REVIEWED is not False"; exit 2; }
grep -qx 'LAUNCH_PRODUCER_REVIEWED = False' "$P/base-launch-producer-stage/r3/wrapper/chain_service.py" || { echo "## HARNESS: launcher r3 LAUNCH_PRODUCER_REVIEWED is not False"; exit 2; }
for v in PYTHONDONTWRITEBYTECODE PYTHONPYCACHEPREFIX; do [ -z "${!v+x}" ] || { echo "## HARNESS: $v is set; the suite must run as an ordinary bytecode-writing caller"; exit 2; }; done
[ -z "${ENCLAVE_BASE_LAUNCH_HANDSHAKE+x}" ] || { echo "## HARNESS: the unit drop-in marker must not be set for tests"; exit 2; }
[ ! -e /etc/enclave-rpc/base-bootstrap-archive ] && [ ! -e /etc/enclave-rpc/base-finality-watermark ] || { echo "## HARNESS: a real launch archive exists on this host; the r3 regression uses the default path"; exit 2; }
export ANCHOR_DEPS_ROOT=${ANCHOR_DEPS_ROOT:-$P/relay-consumer-source}
OUT=$S/logs/root-reanchor-r6-tests-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$OUT" || exit 2
# every real capture copies the node binary (~56 MB) into its private directory: temporary trees live on disk, not tmpfs
mkdir -p "$OUT/tmp" && export TMPDIR="$OUT/tmp" || exit 2
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
(cd "$S" && timeout 3600 python3 -E -s -u tests/test_reanchor_recovery.py) < /dev/null > "$OUT/reanchor-recovery.out" 2>&1; check reanchor-recovery 19 $?
grep -q 'code/__pycache__' "$OUT/reanchor-recovery.out" && { echo "FAIL a capture still published a bytecode cache"; rc=1; }
(cd "$S" && sha256sum -c --quiet MANIFEST.sha256) || { echo "FAIL stage files CHANGED during the run"; rc=1; }
(cd "$CAP" && sha256sum -c --quiet SHA256SUMS) || { echo "FAIL capture/r4 files CHANGED during the run"; rc=1; }
echo "## logs: $OUT"; echo "## aggregate rc=$rc"; exit $rc

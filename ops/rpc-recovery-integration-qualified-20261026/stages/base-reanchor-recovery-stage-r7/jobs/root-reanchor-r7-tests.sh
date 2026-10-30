#!/bin/bash
# base-reanchor-recovery-stage/r7 tests (ROOT runs them; Claude did not). Local, offline, queue cap 256 MiB (r6 observed peak 215), foreground:
#   S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-reanchor-recovery-stage/r7
#   python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log $S/logs/root-reanchor-r7-tests.guard -- unshare -rn bash $S/jobs/root-reanchor-r7-tests.sh > $S/logs/root-reanchor-r7-tests.out 2>&1; echo $? > $S/logs/root-reanchor-r7-tests.rc
# r7 = r6 with ONE test-fixture change (tests/test_reanchor_recovery.py: run_step reads the run record its own invocation wrote; the
# stale probe asserts the clock restore). Every product/runtime file and every other suite file is byte-identical to r6 (checked below),
# so root's ACTUAL r6 results for the other three suites are REUSED as pinned evidence (95 = 34 + 34 + 27, logs/root-reanchor-r6-0336 +
# r6/logs/root-reanchor-r6-tests-20261026T033407Z, sha256 in inputs/consumed-inputs.sha256). Executed here: ONLY
#   reanchor-recovery    tests/test_reanchor_recovery.py (19; capture tests use the REAL capture/r4 module; ordinary caller, no -B)   19
# PASS requires: rc 0, final line exactly "OK", "Ran 19 tests", no skip/expected failure/unexpected success, no code/__pycache__ in the
# output, stage + capture/r4 unchanged afterwards. Aggregate PASS = the reused 95 verified + the 19 PASS. Queue exit 98 = not started.
set -uo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$P/base-reanchor-recovery-stage/r7; R6=$P/base-reanchor-recovery-stage/r6; CAP=$P/a1-capture-binding-stage/r4
L6=$R6/logs/root-reanchor-r6-tests-20261026T033407Z
ip link set lo up 2>/dev/null || true
(cd "$S" && sha256sum -c --quiet MANIFEST.sha256) || { echo "## HARNESS: stage files changed"; exit 2; }
sha256sum -c --quiet "$S/inputs/consumed-inputs.sha256" || { echo "## HARNESS: consumed inputs (incl. r6 evidence) changed"; exit 2; }
(cd "$R6" && sha256sum -c --quiet MANIFEST.sha256) || { echo "## HARNESS: r6 (frozen) changed"; exit 2; }
(cd "$CAP" && sha256sum -c --quiet SHA256SUMS) || { echo "## HARNESS: capture/r4 (frozen) changed"; exit 2; }
# product + every reused suite's files byte-identical to r6: only tests/test_reanchor_recovery.py may differ
for f in $(cd "$R6" && awk '{print $2}' MANIFEST.sha256 | grep -v -e '^./tests/test_reanchor_recovery.py$' -e '^./jobs/' -e '^./inputs/' -e '^./R6-CHANGES.md$'); do
  cmp -s "$R6/$f" "$S/$f" || { echo "## HARNESS: $f differs from r6: the r6 evidence cannot be reused"; exit 2; }; done
capsha=$(sha256sum "$CAP/src/a1_capture.py" | cut -c1-64); hsha=$(sha256sum "$S/harness/a2a4.py" | cut -c1-64)
grep -qx "A1_CAPTURE_SHA256 = '$capsha'   # a1-capture-binding-stage/r4/src/a1_capture.py" "$S/harness/a2a4.py" || { echo "## HARNESS: harness capture pin != capture/r4"; exit 2; }
grep -q "^RECOVERY_A2A4_SHA256 = '$hsha'" "$S/producer/base_launch.py" || { echo "## HARNESS: producer harness pin != harness"; exit 2; }
grep -qx 'A1_CAPTURE_REVIEWED = False' "$S/harness/a2a4.py" || { echo "## HARNESS: capture HOLD flag is not False"; exit 2; }
grep -qx 'FINALITY_PROOF_REVIEWED = False' "$P/base-launch-producer-stage/r3/producer/base_launch.py" || { echo "## HARNESS: launcher r3 FINALITY_PROOF_REVIEWED is not False"; exit 2; }
grep -qx 'LAUNCH_PRODUCER_REVIEWED = False' "$P/base-launch-producer-stage/r3/wrapper/chain_service.py" || { echo "## HARNESS: launcher r3 LAUNCH_PRODUCER_REVIEWED is not False"; exit 2; }
for row in 'PASS baseline-existing Ran 34 (expected 34)' 'PASS recovery-existing Ran 34 (expected 34)' 'PASS r3-regression Ran 27 (expected 27)'; do
  grep -Fxq "$row" "$P/logs/root-reanchor-r6-0336.out" || { echo "## HARNESS: r6 evidence row missing: $row"; exit 2; }; done
for x in baseline-existing:34 recovery-existing:34 r3-regression:27; do f=$L6/${x%%:*}.out
  grep -qx "Ran ${x##*:} tests in [0-9.]*s" "$f" && [ "$(grep -E '^(OK|FAILED)' "$f" | tail -1)" = OK ] || { echo "## HARNESS: r6 ${x%%:*} log is not ${x##*:} OK"; exit 2; }; done
echo "REUSED (exact r6 evidence, product byte-identical): baseline-existing 34 + recovery-existing 34 + r3-regression 27 = 95 PASS"
for v in PYTHONDONTWRITEBYTECODE PYTHONPYCACHEPREFIX; do [ -z "${!v+x}" ] || { echo "## HARNESS: $v is set; the suite must run as an ordinary caller"; exit 2; }; done
[ -z "${ENCLAVE_BASE_LAUNCH_HANDSHAKE+x}" ] || { echo "## HARNESS: the unit drop-in marker must not be set for tests"; exit 2; }
[ ! -e /etc/enclave-rpc/base-bootstrap-archive ] && [ ! -e /etc/enclave-rpc/base-finality-watermark ] || { echo "## HARNESS: a real launch archive exists on this host"; exit 2; }
export ANCHOR_DEPS_ROOT=${ANCHOR_DEPS_ROOT:-$P/relay-consumer-source}
OUT=$S/logs/root-reanchor-r7-tests-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$OUT/tmp" && export TMPDIR="$OUT/tmp" || exit 2
rc=0; f="$OUT/reanchor-recovery.out"
(cd "$S" && timeout 3600 python3 -E -s -u tests/test_reanchor_recovery.py) < /dev/null > "$f" 2>&1; r=$?
ran=$(grep -oE '^Ran [0-9]+ tests?' "$f" | tail -1 | grep -oE '[0-9]+'); last=$(grep -E '^(OK|FAILED)' "$f" | tail -1)
if [ "$r" = 0 ] && [ "$last" = OK ] && [ "$ran" = 19 ] && ! grep -qE 'skipped|expected failure|unexpected success' "$f"; then echo "PASS reanchor-recovery Ran $ran (expected 19)"
else echo "FAIL reanchor-recovery rc=$r ran=${ran:-none} expected=19 last='$last'"; tail -60 "$f"; rc=1; fi
grep -q 'code/__pycache__' "$f" && { echo "FAIL a capture published a bytecode cache"; rc=1; }
(cd "$S" && sha256sum -c --quiet MANIFEST.sha256) || { echo "FAIL stage files CHANGED during the run"; rc=1; }
(cd "$CAP" && sha256sum -c --quiet SHA256SUMS) || { echo "FAIL capture/r4 files CHANGED during the run"; rc=1; }
echo "## logs: $OUT"; echo "## aggregate (95 reused + 19 executed) rc=$rc"; exit $rc

#!/bin/bash
# base-wrapper-integration-stage tests (ROOT runs them; Claude did not). Pure Python, offline, no client, no network:
#   S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-wrapper-integration-stage
#   python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log $S/logs/root-wrapper-tests.guard -- unshare -rn bash $S/jobs/root-wrapper-tests.sh
# Runs (1) the EXISTING test_chain_service.py, unchanged, against the BASE wrapper (baseline) and against the CANDIDATE, and
# (2) the new test_chain_service_release.py against the candidate. Each suite must report OK with 0 skipped/expected
# failures; the run must not be as uid 0 (the tests use a test-owned TRUSTED_TOP; root would mask ownership checks).
set -uo pipefail
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-wrapper-integration-stage
(cd "$S" && sha256sum -c --quiet MANIFEST.sha256) || { echo "## HARNESS: pinned stage files changed"; exit 2; }
[ "$(id -u)" != 0 ] || echo "## NOTE: inside unshare -r the uid is mapped to 0 for the namespace; files are owned by that same mapped uid, so the owner checks still compare real values"
OUT=$S/logs/root-wrapper-tests-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$OUT" || exit 2
rc=0
suite() { local label=$1 dir=$2 file=$3 r
  (cd "$dir" && TEST_TMP="$OUT" timeout 300 python3 -E -s -m unittest -v "${file%.py}") > "$OUT/$label.out" 2>&1; r=$?
  local ran=$(grep -oE '^Ran [0-9]+ tests?' "$OUT/$label.out" | tail -1)
  if [ $r = 0 ] && grep -qE '^OK$' "$OUT/$label.out" && ! grep -qE 'skipped|expected failure' "$OUT/$label.out"; then echo "PASS $label $ran"; else echo "FAIL $label rc=$r $ran"; tail -20 "$OUT/$label.out"; rc=1; fi; }
suite baseline-existing "$S/base" test_chain_service.py
suite candidate-existing "$S/src" test_chain_service.py
suite candidate-release "$S/src" test_chain_service_release.py
echo "## logs: $OUT"; echo "## aggregate rc=$rc"; exit $rc

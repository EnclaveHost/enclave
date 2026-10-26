#!/usr/bin/env bash
# repo-tests (queue 512): the COMMIT's own existing offline tests for the verifier-only binding and every rejection
# (synthetic SNP chain, loopback only; no hardware, no network). Run from the read-only staged tree; temp files in $D/tmp.
set -uo pipefail
. "$(dirname "$0")/env.sh"
export TMPDIR=$D/tmp; mkdir -p "$TMPDIR"; cd "$D/tree"
F=${1:?test file}; N=$(basename "$F" .test.mjs)
node --test --test-concurrency=1 "$F" > "$D/rawlogs/repo-$N.tap" 2>&1; rc=$?
grep -E "^# (tests|pass|fail|skipped|cancelled) |^not ok" "$D/rawlogs/repo-$N.tap"
echo "stub invocations: $(( $(wc -l < "$D/logs/ssh-stub-invocations.log") - STUB_BASE ))"; echo "REPO-TESTS rc=$rc"; exit $rc

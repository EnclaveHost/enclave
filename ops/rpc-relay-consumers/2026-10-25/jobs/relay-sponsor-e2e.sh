#!/bin/bash
# host-sponsor on the REAL pinned verifier + own backend, offline reth (test-control.sh: unshare -n); missing artifacts FAIL;
# skips are not passes. Needs jobs/forge-prebuild-sponsor.sh output (contracts/foundry/out) first.
set -uo pipefail
N=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
export REQUIRE_VERIFIER_E2E=1 REPO_DIR=$N/relay-consumer-source
label=${1:-r1}; shift || true
files=${*:-test/relay-sponsor-verifier.e2e.test.mjs}
bash $N/test-control.sh relay-sponsor-$label $files > $N/logs/relay-sponsor-$label.tap 2>&1; rc=$?
grep -E "^(ok|not ok) |^# (tests|pass|fail|skipped|cancelled)|OBSERVED" $N/logs/relay-sponsor-$label.tap > $N/logs/relay-sponsor-$label.summary
grep -q "^# skipped 0$" $N/logs/relay-sponsor-$label.summary || { echo "skips present: not a pass" >> $N/logs/relay-sponsor-$label.summary; rc=1; }
echo "rc=$rc" >> $N/logs/relay-sponsor-$label.summary
exit $rc

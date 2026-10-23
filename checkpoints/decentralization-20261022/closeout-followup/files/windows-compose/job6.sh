#!/usr/bin/env bash
# job6.sh: (a) composed tree: the anvil-gated suites J5b skipped (off-chain heartbeat parity, session auth) with Foundry on PATH;
# (b) CONTROL on the unmodified normal tree f58e03e: the five files that failed in J5b part 1 must fail identically there.
set -uo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/windows-compose
echo "=== (a) composed: offchain-heartbeat-writers + session-api-auth with anvil"; EXTRA_PATH=/home/steven/.foundry/bin TEST_TIMEOUT_MS=200000 MODE=test JOB_SEC=420 "$HERE/job.sh" test/offchain-heartbeat-writers.test.mjs test/session-api-auth.test.mjs; r=$?
echo "=== (b) CONTROL normal tree: the five J5b failures"; TREE="$HERE/tmp/norm" MODE=test JOB_SEC=150 "$HERE/job.sh" test/catalog-platform-enforcement.test.mjs test/network-consumer-bundle.test.mjs test/platform-host-policy-process.test.mjs test/registry-reconcile.test.mjs test/supervisor-wallet-policy.test.mjs; c=$?
echo "[job6] composed=$r control=$c"; [ $r -eq 0 ]

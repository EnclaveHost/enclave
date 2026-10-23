#!/usr/bin/env bash
# job7.sh: (b) CONTROL on the unmodified normal tree: the five J5b failures; (c) a SINGLE-THREADED offline forge build of THIS
# tree's contracts (contracts/foundry/out, gitignored test input; the two-solc default build exceeded 1536 MiB in wc6b);
# (d) composed tree: offchain-heartbeat-writers with anvil (off-chain routine liveness parity).
set -uo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/windows-compose
echo "=== (b) CONTROL normal tree: the five J5b failures"; TREE="$HERE/tmp/norm" MODE=test JOB_SEC=150 "$HERE/job.sh" test/catalog-platform-enforcement.test.mjs test/network-consumer-bundle.test.mjs test/platform-host-policy-process.test.mjs test/registry-reconcile.test.mjs test/supervisor-wallet-policy.test.mjs; c=$?
echo "=== (c) forge build -j 1 --offline (composed tree)"
cd "$HERE/candidate"; export PATH="$HERE/stubs:/home/steven/.foundry/bin:/usr/local/bin:/usr/bin:/bin"
timeout -k 10 1500 unshare -rn --pid --fork --kill-child --mount-proc forge build -j 1 --offline; b=$?
echo "[job7] forge build exit=$b"; ls contracts/foundry/out 2>/dev/null | wc -l
[ $b -eq 0 ] || { echo "[job7] control=$c build=$b"; exit 3; }
echo "=== (d) composed: offchain-heartbeat-writers with anvil"; EXTRA_PATH=/home/steven/.foundry/bin TEST_TIMEOUT_MS=900000 MODE=test JOB_SEC=1200 "$HERE/job.sh" test/offchain-heartbeat-writers.test.mjs; r=$?
echo "[job7] control=$c build=$b heartbeat=$r"; [ $r -eq 0 ]

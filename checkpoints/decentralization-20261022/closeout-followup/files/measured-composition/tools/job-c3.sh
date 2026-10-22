#!/usr/bin/env bash
# job-c3: ONE queued job (512 MiB), bash only: the MCP end-to-end suite on tree-c with work/enclave's Foundry build output
# linked READ-ONLY at contracts/foundry/out (gitignored; the established candidate-test practice), removed afterwards.
set -uo pipefail
M=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/measured-composition; T=$M/tree-c; O=$M/out/c
[ ! -e "$T/contracts/foundry/out" ] || { echo "out already present"; exit 2; }
ln -s /home/steven/Documents/Codex/2026-10-18/wo/work/enclave/contracts/foundry/out "$T/contracts/foundry/out"
cd "$T"; node --test --test-concurrency=1 test/mcp-hosted-control.test.mjs > "$O/t-mcp-hosted-control-e2e.log" 2>&1; r=$?
rm "$T/contracts/foundry/out"
echo "[c] t-mcp-hosted-control-e2e: rc=$r"; grep -E "^# (tests|pass|fail|skipped|cancelled) |^not ok|# SKIP" "$O/t-mcp-hosted-control-e2e.log"
s=$(GIT_DIR="$T/.git" GIT_WORK_TREE="$T" GIT_OPTIONAL_LOCKS=0 git status --porcelain --untracked-files=all | grep -v "node_modules/" | grep -v " relay/network-runtime.bundle.mjs" | head -5)
[ -z "$s" ] && echo "[c] clean-after-e2e: OK" || { echo "[c] clean-after-e2e: FAIL $s"; r=1; }
exit $r

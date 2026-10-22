#!/bin/sh
# CLI suite only (cli/enclave.mjs and test/cli.test.mjs changed after job-unit run 2, nothing else).
set -e
cd /home/steven/Documents/Codex/2026-10-18/wo/work/history-checkpoint-transport/tree
node --test --test-concurrency=1 test/cli.test.mjs
echo CLI-OK

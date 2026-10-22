#!/usr/bin/env bash
# the post-cutover audit's local tests (anvil chain audit + acceptance + collector plumbing). Through the shared queue:
#   python3 ../claude-test-queue.py --mib 512 --log logs/t.guard.log -- bash run-tests.sh logs/t.log
set -u
cd "$(dirname "$0")"; LOG=${1:?log}; exec > "$LOG" 2>&1
for f in collect-minipc.sh collect-source.sh run-tests.sh; do bash -n "$f" && echo "bash -n $f: ok" || exit 1; done
for f in audit-chain.mjs accept.mjs find-cutover-block.mjs; do node --check "$f" && echo "node --check $f: ok" || exit 1; done
node --test --test-concurrency=1 --test-timeout=300000 test/accept.test.mjs test/collectors.test.mjs test/audit-chain.test.mjs; e=$?
echo "=== EXIT $e"; exit $e

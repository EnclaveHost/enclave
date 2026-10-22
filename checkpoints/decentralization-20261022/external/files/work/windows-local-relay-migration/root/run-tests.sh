#!/usr/bin/env bash
# The source lifecycle tests (mock filesystem + mock systemctl; nothing real is touched). Through the shared queue:
#   python3 ../../claude-test-queue.py --mib 256 --log ../logs/lifecycle.guard.log -- bash root/run-tests.sh ../logs/lifecycle.log
set -u
cd "$(dirname "$0")"
LOG=${1:?log}; exec > "$LOG" 2>&1
for f in *.sh; do bash -n "$f" && echo "bash -n $f: ok" || exit 1; done
node --test --test-concurrency=1 test/source-lifecycle.test.mjs test/ps-check-failclosed.test.mjs; e=$?
echo "=== EXIT $e"; exit $e

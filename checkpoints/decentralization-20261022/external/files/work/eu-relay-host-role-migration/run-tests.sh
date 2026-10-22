#!/usr/bin/env bash
# The workspace's tests (mock hosts; a local anvil for the real package). Through the shared queue (256 MiB):
#   python3 ../claude-test-queue.py --mib 256 --log logs/tests.guard.log -- bash run-tests.sh logs/tests.log
set -u
cd "$(dirname "$0")"
LOG=${1:?log}; exec > "$LOG" 2>&1
for f in root/*.sh; do bash -n "$f" && echo "bash -n $f: ok" || exit 1; done
node --test --test-concurrency=1 test/eu-lifecycle.test.mjs; a=$?
# in-process (no test-runner parent): the real-package test runs anvil + the relay child, within the 256 MiB light cap
node test/host-role-import.test.mjs; b=$?
e=$(( a != 0 ? a : b ))
echo "=== EXIT $e"; exit $e

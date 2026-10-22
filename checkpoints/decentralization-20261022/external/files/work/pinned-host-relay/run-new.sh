#!/usr/bin/env bash
# The two new test files, in the candidate tree. Through the shared queue (512 MiB: one anvil + the packaged relay child):
#   python3 ../claude-test-queue.py --mib 512 --log logs/new-N.guard.log -- bash run-new.sh logs/new-N.log
set -u
cd "$(dirname "$0")/tree"
LOG=${1:?log}; exec > "../$LOG" 2>&1
node --test --test-concurrency=1 test/lease-pinned-relay-config.test.mjs; a=$?
node test/lease-pinned-relay.test.mjs; b=$?
echo "=== EXIT config=$a chain=$b"; [ $a -eq 0 ] && [ $b -eq 0 ]

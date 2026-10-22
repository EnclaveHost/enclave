#!/bin/bash
# run-test.sh <repo dir> <test file>: one node --test run in a PRIVATE network namespace (loopback only), serial, bounded.
set -u
cd "$1" || exit 2
exec unshare -rn sh -c 'ip link set lo up && exec timeout -k 5 120 node --test --test-concurrency=1 --test-force-exit --test-reporter=spec "$0"' "$2"

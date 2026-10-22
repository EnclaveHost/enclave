#!/bin/bash
# run-test.sh <repo dir> <test file>: one node --test run in a PRIVATE network namespace (loopback only), serial.
set -u
cd "$1" || exit 2
exec unshare -rn sh -c 'ip link set lo up && exec node --test --test-concurrency=1 --test-reporter=spec "$0"' "$2"

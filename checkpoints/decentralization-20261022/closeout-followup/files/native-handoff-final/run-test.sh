#!/bin/bash
# run-test.sh <repo dir> <test file> [timeout s]: one node --test run in a PRIVATE network + pid namespace (loopback only), serial.
set -u
cd "$1" || exit 2
exec timeout -k 10 "${3:-540}" unshare -rn --pid --fork --kill-child --mount-proc sh -c 'ip link set lo up && exec node --test --test-concurrency=1 --test-reporter=spec "$0"' "$2"

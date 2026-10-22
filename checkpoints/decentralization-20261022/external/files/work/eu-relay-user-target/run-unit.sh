#!/usr/bin/env bash
# The focused tests that need no chain and no user manager: the frozen release (verifier, self-contained closure,
# freshness, determinism), the fixed LAN forwarder on loopback sockets, and the user-target lifecycle on mock hosts.
#   python3 ../claude-test-queue.py --mib 512 --log logs/unit-N.guard.log -- bash run-unit.sh logs/unit-N.log
set -u
cd "$(dirname "$0")"
LOG=${1:?log}; exec > "$LOG" 2>&1
export TMPDIR=$PWD/.tmp-unit; mkdir -p "$TMPDIR"
for f in user/*.sh source/*.sh; do bash -n "$f" && echo "bash -n $f: ok" || exit 1; done
node --test --test-concurrency=1 test/release.test.mjs test/lan-forwarder.test.mjs test/user-lifecycle.test.mjs; e=$?
rm -rf "$TMPDIR"
echo "=== EXIT $e"; exit $e

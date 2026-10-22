#!/usr/bin/env bash
# The REAL fixtures (multiprocess: anvil, transient user units, relay children): the frozen role as a transient user unit
# with the template's settings plus the per-user IP access-list probe; then main's own role test (REAL platform gate,
# ban/unban, the actual `run` CLI) pointed at the FROZEN copy of lease-relay-host.mjs (LEASE_RELAY_HOST_UNDER_TEST).
#   python3 ../claude-test-queue.py --mib 768 --log logs/fixtures-N.guard.log -- bash run-fixtures.sh logs/fixtures-N.log
set -u
cd "$(dirname "$0")"; WS=$PWD
LOG=${1:?log}; exec > "$LOG" 2>&1
node test/user-unit-fixture.test.mjs; a=$?
X=$(mktemp -d "$WS/.frozen-XXXXXX"); TAR=$(ls release/*.tar); ID=$(basename "$TAR" .tar)
tar -xf "$TAR" -C "$X" --no-same-owner && find "$X/$ID" -type d -exec chmod 0700 {} + && find "$X/$ID" -type f -exec chmod 0600 {} +
node "$X/$ID/verify-release.mjs"; v=$?
( cd ../enclave && LEASE_RELAY_HOST_UNDER_TEST="$X/$ID/app/network/host-services/lease-relay-host.mjs" node --test --test-concurrency=1 test/lease-relay-host-policy.test.mjs ); b=$?
rm -rf "$X"
echo "=== EXIT fixture=$a verify=$v role-under-test=$b"; [ $a -eq 0 ] && [ $v -eq 0 ] && [ $b -eq 0 ]

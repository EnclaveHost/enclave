#!/usr/bin/env bash
# final: the candidate batch, then (not gating) the consumed-own-receipt test on UNMODIFIED main's client (control/)
set -u
cd "$(dirname "$0")"
bash run-batch.sh; b=$?
echo "=== CONTROL (expected to fail on unmodified main)"
( cd control && node --test --test-concurrency=1 test/lease-consumed-own-receipt.test.mjs; echo "=== CONTROL EXIT $?" )
exit $b

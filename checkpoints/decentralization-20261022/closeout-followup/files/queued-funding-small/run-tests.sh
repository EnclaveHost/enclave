#!/usr/bin/env bash
# Offline tests (queue 256/512): node --test of the small batch plan against a fake RPC quorum; no network (private namespace), wallet or server.
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p tmp; export TMPDIR="$PWD/tmp"
exec timeout -k 10 240 unshare -rn sh -c 'exec node --test --test-concurrency=1 --test-reporter=spec test/batch-plan-small.test.mjs'

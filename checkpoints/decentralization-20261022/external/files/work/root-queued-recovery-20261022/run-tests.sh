#!/usr/bin/env bash
# Offline tests (queue 256): node --test of the batch plan against a fake RPC quorum; no network, wallet or server.
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p tmp; export TMPDIR="$PWD/tmp"
node --test --test-concurrency=1 --test-reporter=spec test/batch-plan.test.mjs
rmdir tmp 2>/dev/null || true

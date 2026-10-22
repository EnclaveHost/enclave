#!/usr/bin/env bash
# Offline tests of this package (queue 256): the adapter model on the real release, then the client against a loopback stub.
# node --test runs the files in alphabetical order, one at a time. Temporary files live under ./tmp (not RAM-backed /tmp).
set -euo pipefail
P=$(cd "$(dirname "$0")/.." && pwd); mkdir -p "$P/tmp"; export TMPDIR="$P/tmp"
cd "$P" && node --test --test-concurrency=1 --test-reporter=spec test/a-model-release.test.mjs test/b-client.test.mjs
rmdir "$P/tmp" 2>/dev/null || true

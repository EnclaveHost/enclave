#!/usr/bin/env bash
# Local tests only (loopback model + loopback gateway; no network). Run via the shared queue (512).
cd "$(dirname "$0")" && TMPDIR=$(mktemp -d) && trap 'rm -rf "$TMPDIR"' EXIT && export TMPDIR
timeout 600 node --test --test-concurrency=1 test/plan.test.mjs test/handoff.test.mjs 2>&1

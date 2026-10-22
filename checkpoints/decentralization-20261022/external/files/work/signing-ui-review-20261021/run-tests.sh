#!/usr/bin/env bash
# focused regression tests only (browserless; real server.mjs on the in-memory Base model; temp journals; loopback only)
cd "$(dirname "$0")" && TMPDIR=$(mktemp -d) && trap 'rm -rf "$TMPDIR"' EXIT && export TMPDIR
timeout 90 node --test --test-concurrency=1 test/ui.test.mjs 2>&1

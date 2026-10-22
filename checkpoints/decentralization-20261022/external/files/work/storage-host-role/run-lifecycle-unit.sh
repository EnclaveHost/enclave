#!/bin/bash
# Deterministic supervisor lifecycle tests (fake children, injected admission; real startPostgres readiness logic).
cd "$(dirname "$0")/tree" || exit 2
node --test --test-concurrency=1 test/storage-indexer-host-lifecycle.test.mjs

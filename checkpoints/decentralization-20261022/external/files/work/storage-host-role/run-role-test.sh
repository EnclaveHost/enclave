#!/bin/bash
# The storage-indexer host-role lifecycle test (real processes: policy world, PostgreSQL 18.6 scratch runtime, indexd G-C2).
cd "$(dirname "$0")/tree" || exit 2
node --test --test-concurrency=1 test/storage-indexer-host.test.mjs

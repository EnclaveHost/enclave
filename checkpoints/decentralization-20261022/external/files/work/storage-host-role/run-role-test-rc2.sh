#!/bin/bash
# The host-role lifecycle test against the rc2 dist tarball (the production candidate package).
cd "$(dirname "$0")/tree" || exit 2
STORAGE_PACKAGE_TARBALL="$(cd .. && pwd)/package/dist/enclave-storage-indexer-1.0.0-rc2.tar.zst" node --test --test-concurrency=1 test/storage-indexer-host.test.mjs

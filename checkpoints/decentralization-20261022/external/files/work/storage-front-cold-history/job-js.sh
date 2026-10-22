#!/bin/sh
# The relay reader's resource bounds and the suites of every relay file they touch.
set -e
cd /home/steven/Documents/Codex/2026-10-18/wo/work/storage-front-cold-history/tree
node --test --test-concurrency=1 test/storage-front-resource-bounds.test.mjs test/storage-front-binding.test.mjs \
  test/storage-front-binding-release.test.mjs test/storage-front-binding-shield.test.mjs test/secrets-release.test.mjs test/relay-deploy-closure.test.mjs
echo JS-OK
node --test --test-concurrency=1 test/api-relay.test.mjs
echo API-RELAY-OK

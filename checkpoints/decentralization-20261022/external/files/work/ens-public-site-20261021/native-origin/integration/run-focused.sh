#!/usr/bin/env bash
# The three root-integrated incident tests, once, against the actual work/enclave source (no other suites).
cd /home/steven/Documents/Codex/2026-10-18/wo/work/enclave
sha256sum relay/api-relay.js relay/secrets.js test/cors-ens-origins.test.mjs test/relay-exists-fastpath.test.mjs test/custody-relay.test.mjs
node --test --test-concurrency=1 --test-reporter=spec test/cors-ens-origins.test.mjs test/custody-relay.test.mjs test/relay-exists-fastpath.test.mjs
echo "node-test-rc=$?"

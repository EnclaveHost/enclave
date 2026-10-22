#!/usr/bin/env bash
# The two daemon-level suites that POST /v1/secrets/exists through a booted api-relay.js (patched stage copy).
set -euo pipefail
R=/home/steven/Documents/Codex/2026-10-18/wo/work/nucbox-tls-20261021/relay-exists
export TMPDIR=$R/tmp
cd $R/stage
node --test --test-concurrency=1 test/api-relay.test.mjs test/relay-hvnode-owner-only.test.mjs
echo "DAEMON-SUITES: PASS"

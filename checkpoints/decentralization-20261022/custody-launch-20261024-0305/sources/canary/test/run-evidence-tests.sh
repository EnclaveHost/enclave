#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
# No network, signing, production files, hardware or driver CLI invocation.
exec timeout -k 5 240 node --test --test-concurrency=1 --test-timeout=60000 test/proof.test.mjs test/assert.test.mjs test/prepare.test.mjs

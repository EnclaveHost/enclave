#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
for f in driver/*.mjs driver/launch/*.mjs test/*.mjs tools/*.mjs; do timeout -k 5 20 node --check "$f"; done
python3 test/inspect-caddy.test.py
# Import the CLI without invoking its entry point: catches stale exports, no keys or RPC calls.
timeout -k 5 20 node --input-type=module -e 'await import("./driver/cli.mjs")'
timeout -k 5 240 node --test --test-force-exit --test-concurrency=1 --test-timeout=60000 test/*.test.mjs

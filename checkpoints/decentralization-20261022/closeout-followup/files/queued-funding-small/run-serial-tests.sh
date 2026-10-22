#!/usr/bin/env bash
# serial-fetch tests (queue 256): private network namespace, hard deadline; no network, wallet or server
set -euo pipefail
cd "$(dirname "$0")"
exec timeout -k 10 120 unshare -rn sh -c 'exec node --test --test-concurrency=1 --test-reporter=spec test/serial-fetch.test.mjs'

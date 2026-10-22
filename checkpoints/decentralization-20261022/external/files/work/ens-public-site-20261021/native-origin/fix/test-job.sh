#!/usr/bin/env bash
# One queued job: the CORS test against the PATCHED live relay file (must pass), then against the UNPATCHED live file
# (negative control: must fail exactly the ENS-origin assertions).
cd "$(dirname "$0")/tree"
echo "== patched (fix/api-relay.js)"; RELAY_FILE=api-relay.js node --test --test-concurrency=1 test/cors-ens-origins.test.mjs 2>&1 | grep -E "^# (pass|fail)|^not ok|^ok|ENS|must" | head -30; p=${PIPESTATUS[0]}
echo "== negative control (live base, unpatched)"; RELAY_FILE=api-relay.live-base.js node --test --test-concurrency=1 test/cors-ens-origins.test.mjs 2>&1 | grep -E "^# (pass|fail)|^not ok|^ok|must be allowed|expected|actual" | head -30; n=${PIPESTATUS[0]}
echo "patched-rc=$p control-rc=$n"

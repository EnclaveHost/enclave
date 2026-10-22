#!/bin/bash
# After syncing root's public-directory.mjs (routeContext fix, 16:49Z): the two suites that load it.
set -uo pipefail
H=$(cd "$(dirname "$0")/.." && pwd); cd "$H/tree"
node --test --test-concurrency=1 --test-reporter=tap test/host-service-replica-peers.test.mjs test/host-service-cold-bootstrap.test.mjs > "$H/logs/pubdir.tap" 2>&1
grep -E "^# (tests|pass|fail|skipped)|^not ok" "$H/logs/pubdir.tap"; grep -q "^# fail 0" "$H/logs/pubdir.tap"

#!/bin/bash
# Re-run of the one file (hosted-service-placement) that failed ONLY on modules missing from the tree (isolation/, site/, custody/ now copied).
set -uo pipefail
H=$(cd "$(dirname "$0")/.." && pwd)
cd "$H/tree"
F="test/hosted-service-placement.test.mjs"
node --test --test-concurrency=2 --test-timeout=120000 --test-reporter=tap $F > "$H/logs/node-rerun2.tap" 2>&1
grep -E "^# (tests|pass|fail|skipped)" "$H/logs/node-rerun2.tap"; grep -E "^not ok" "$H/logs/node-rerun2.tap" | head -20
grep -q "^# fail 0" "$H/logs/node-rerun2.tap" && echo RERUN-OK || { echo RERUN-FAILED; exit 1; }

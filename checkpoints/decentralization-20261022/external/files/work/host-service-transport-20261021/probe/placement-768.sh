#!/bin/bash
# The ONE root-approved (16:04:35Z) 768 MiB job: test/hosted-service-placement.test.mjs on the complete tree (two hosts'
# packaged roles plus Anvil). It exercises roles.mjs (appStatic lists) under the real runner.
set -uo pipefail
H=$(cd "$(dirname "$0")/.." && pwd); cd "$H/tree"
node --test --test-concurrency=1 --test-timeout=300000 --test-reporter=tap test/hosted-service-placement.test.mjs > "$H/logs/placement.tap" 2>&1
grep -E "^# (tests|pass|fail|skipped)|^not ok" "$H/logs/placement.tap"; grep -q "^# fail 0" "$H/logs/placement.tap"

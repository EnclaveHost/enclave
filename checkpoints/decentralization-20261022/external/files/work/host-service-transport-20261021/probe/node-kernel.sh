#!/bin/bash
# Re-run of test/wg-provider-dns-kernel.test.mjs after its --ruleset fixture got a complete authority-pin set.
set -uo pipefail
H=$(cd "$(dirname "$0")/.." && pwd); cd "$H/tree"
MAIN_KERNEL="$H/../enclave/network/wg-provider/kernel.mjs" node --test --test-reporter=tap test/wg-provider-dns-kernel.test.mjs > "$H/logs/final-kernel.tap" 2>&1
grep -E "^# (tests|pass|fail|skipped)|^not ok" "$H/logs/final-kernel.tap"; grep -q "^# fail 0" "$H/logs/final-kernel.tap"

#!/usr/bin/env bash
# (immutable; debug v1) only the real-contract suite, its first case, with full output on failure
set -uo pipefail
cd "$(dirname "$0")/tree"
node --test --test-concurrency=1 --test-name-pattern='0/0: exactly one' test/owner-nomination.test.mjs 2>&1 | head -150

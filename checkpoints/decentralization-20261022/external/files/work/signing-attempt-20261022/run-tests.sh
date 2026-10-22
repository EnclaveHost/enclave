#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
TMPDIR=$(mktemp -d)
export TMPDIR
trap 'rm -rf "$TMPDIR"' EXIT
timeout 90 node --test --test-concurrency=1 wallet-handoff/test/plan.test.mjs wallet-handoff/test/handoff.test.mjs wallet-handoff/test/attempt.test.mjs ui/test/ui.test.mjs > tests.out 2>&1
cat tests.out

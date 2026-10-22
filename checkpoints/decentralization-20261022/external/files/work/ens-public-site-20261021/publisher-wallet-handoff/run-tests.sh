#!/usr/bin/env bash
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/ens-public-site-20261021/publisher-wallet-handoff
export TMPDIR=$H/tmp
cd $H
node --test --test-concurrency=1 test/plan.test.mjs test/handoff.test.mjs
echo "TESTS: PASS"

#!/usr/bin/env bash
# The off-chain heartbeat NEGATIVE CONTROL: the supervisor before the off-chain liveness change (9a307f3ea^:supervisor.js,
# in this history), staged as an UNCOMMITTED scratch file in the repository root (the test runs it beside the current
# modules), on the same counting rig: its routine heartbeat must reach the registry as a Heartbeat event.
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/windows-feature-gap-repair-20261023; cd "$H/candidate"
git show '9a307f3ea^:supervisor.js' > supervisor.base-9a307f3e.js; sha256sum supervisor.base-9a307f3e.js
cd "$H"; OFFCHAIN_HEARTBEAT_BASE_SUPERVISOR="$H/candidate/supervisor.base-9a307f3e.js" ./run-suite.py d3-heartbeat-negctl --job-sec 900 --test-ms 600000 \
  --allow-skip 2 --name-pattern 'negative control' -- test/offchain-heartbeat-writers.test.mjs; rc=$?
rm -f "$H/candidate/supervisor.base-9a307f3e.js"; exit $rc

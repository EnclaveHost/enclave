#!/usr/bin/env bash
# J1b: J1's follow-ups. windows-shield-startup after its fixture states the manager RAM view (M 9f19b7c6 semantics);
# windows/node/hosting.test.mjs with a dummy non-loopback interface in its namespace (its bind negative ran as a skip);
# offchain-heartbeat-writers with its own 900 s test bound (J1's 300 s file bound cancelled it; its negative-control
# subtest needs a base supervisor.js and is the one allowed, reported skip); then the two 4106-era failures on base.
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/windows-final-runtime-integration-20261023; cd "$H"; rc=0
./run-suite.py j1b-shield -- test/windows-shield-startup.test.mjs || rc=1
./run-suite.py j1b-hosting --dummy-if 'windows/node/hosting.test.mjs' -- windows/node/hosting.test.mjs || rc=1
./run-suite.py j1b-heartbeat --allow-skip 1 --job-sec 1800 --test-ms 1500000 -- test/offchain-heartbeat-writers.test.mjs || rc=1
# classification on the prior final (base worktree at 1f19ad15)
./run-suite.py j1b-base --tree "$H/base" -- test/catalog-platform-enforcement.test.mjs test/registry-reconcile.test.mjs && echo "[j1b] base PASSES them" || echo "[j1b] base fails them too"
echo "[j1b] rc=$rc"; exit $rc

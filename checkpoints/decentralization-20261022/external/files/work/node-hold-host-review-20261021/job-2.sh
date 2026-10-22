#!/usr/bin/env bash
set -uo pipefail
D=/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-host-review-20261021; cd $D
./job-bundle.sh
(cd tree && timeout 180 node --test --test-concurrency=1 test/host-admission-runtime.test.mjs 2>&1 | grep -E "^(not )?ok|^# (pass|fail)" | tr '\n' ' '); echo " <- host-admission-runtime on the rebuilt bundle"
./job-7d-tests.sh

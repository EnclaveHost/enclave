#!/usr/bin/env bash
set -uo pipefail
R=/home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021/host-policy-review
export TMPDIR=$R/tmp; cd $R/r3
node build-v3.mjs
ADMISSION_MODULE=$R/r3/v3.bundle.mjs timeout 120 node --test --test-name-pattern "R3" admission-quorum.test.mjs > r3.tap 2>&1; echo rc=$?
grep -E "METRIC all429|^# (pass|fail)|^not ok|^ok" r3.tap

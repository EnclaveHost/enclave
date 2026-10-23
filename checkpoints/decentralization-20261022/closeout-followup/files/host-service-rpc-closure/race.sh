#!/usr/bin/env bash
# policy-mirror race: the new regression on the candidate (fix) and on exact 4106c311 (negative control, must fail).
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-service-rpc-closure; cd "$H"
echo "=== candidate"; STRICT=1 JOB_SEC=200 ./job.sh test/policy-mirror-sync-race.test.mjs; a=$?
echo "=== control 4106c311"; TREE="$H/base" JOB_SEC=200 ./job.sh test/policy-mirror-sync-race.test.mjs; b=$?
echo "[race] candidate=$a control=$b (must be nonzero)"; [ $a -eq 0 ] && [ $b -ne 0 ]

#!/usr/bin/env bash
# Final control + mutants for 6c38c048 (the candidate suites already passed 27/27 in c3-commit-v1).
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-service-lifecycle; cd "$H"
echo "=== V2 control $(git -C base rev-parse HEAD) (test file sha $(sha256sum base/test/host-service-lifecycle.test.mjs | cut -c1-8))"
TREE="$H/base" JOB_SEC=300 TEST_TIMEOUT_MS=280000 ./job.sh test/host-service-lifecycle.test.mjs; v2=$?
echo "=== V3 mutants of $(git -C mut rev-parse HEAD)"
python3 -u mutants.py; v3=$?
echo "[verify] control=$v2 (must be nonzero) mutants=$v3"; [ $v2 -ne 0 ] && [ $v3 -eq 0 ]

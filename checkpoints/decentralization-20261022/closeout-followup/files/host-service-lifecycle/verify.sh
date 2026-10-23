#!/usr/bin/env bash
# Final verification of 862f6549: (1) the new suite + transport/agent suites on the candidate, (2) the same new suite on the
# exact 427780bbc tree (control: must fail), (3) six mutants of 862f6549 (each must be killed).
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-service-lifecycle; cd "$H"
echo "=== V1 candidate $(git -C candidate rev-parse HEAD)"
JOB_SEC=240 ./job.sh test/host-service-lifecycle.test.mjs test/host-service-transport.test.mjs test/privacy-agent-lifecycle.test.mjs; v1=$?
echo "=== V2 control $(git -C base rev-parse HEAD) (test file sha $(sha256sum base/test/host-service-lifecycle.test.mjs | cut -c1-8))"
TREE="$H/base" JOB_SEC=300 TEST_TIMEOUT_MS=280000 ./job.sh test/host-service-lifecycle.test.mjs; v2=$?
echo "=== V3 mutants of $(git -C mut rev-parse HEAD)"
python3 -u mutants.py; v3=$?
echo "[verify] candidate=$v1 control=$v2 (must be nonzero) mutants=$v3"
[ $v1 -eq 0 ] && [ $v2 -ne 0 ] && [ $v3 -eq 0 ]

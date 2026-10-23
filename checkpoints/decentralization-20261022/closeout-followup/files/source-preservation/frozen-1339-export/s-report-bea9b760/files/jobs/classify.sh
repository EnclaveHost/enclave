#!/usr/bin/env bash
# classify the two final failures: host-services-carriers twice on this tree, then carriers + service-index on pristine 14d1e495
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
for i in 1 2; do echo "=== candidate carriers run $i"; JOB_SEC=400 bash "$HERE/jobs/job.sh" test/host-services-carriers.test.mjs | grep -E "^(✔|✖|ℹ (pass|fail))|exit="; done
echo "=== baseline 14d1e495"; TREE="$HERE/baseline-14d1" JOB_SEC=600 bash "$HERE/jobs/job.sh" test/host-services-carriers.test.mjs test/service-index.test.mjs | grep -E "^(✖|ℹ (tests|pass|fail))|exit=|head "

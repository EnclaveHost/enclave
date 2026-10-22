#!/bin/bash
# FINAL regression on the final composition (all review fixes; root's route-record 9ba9f6d3): every Node group, then the
# real-kernel netns e2e with the rebuilt enclave-wg (36dda0c7...).
set -uo pipefail
H=$(cd "$(dirname "$0")/.." && pwd); rc=0
bash "$H/probe/node-final.sh" || rc=1
bash "$H/probe/netns-job.sh" || rc=1
echo "JOB-FINAL-RC=$rc"; exit $rc

#!/bin/bash
# composite-mdbx-validation-stage/r10 job finish (PREPARED by Claude 1833; NOT run by Claude). Review 1831 B1. The ONE post-runtime
# evidence path, used by jobs/root-composite-validate.sh AND by test 16:
#   env -i PATH=/usr/bin:/bin LC_ALL=C EVID_O=<run dir> EVID_S6=<r6 stage> bash finish.sh J_DIR RUNTIME_RC   -> the job's exit code
# 1. collect-evidence.sh after (statuses captured)  2. job-receipt.py (snapshotsOk re-validated from BOTH status files)
# 3. final-status.sh: a nonzero runtime rc is preserved; runtime 0 stays 0 ONLY with complete evidence, else 10 + FINAL-EVIDENCE-FAILED
set -u
R10=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/composite-mdbx-validation-stage/r10
J=${1:?J_DIR}; rc=${2:?RUNTIME_RC}
bash $R10/jobs/collect-evidence.sh after "$J"; arc=$?
( ulimit -f 1024; exec python3 -I -B $R10/jobs/job-receipt.py "${EVID_O:-}" "$J" "$rc" "$arc" > "$J/receipt.json" ); jrc=$?
( ulimit -f 1024; exec bash $R10/jobs/final-status.sh "$rc" "$jrc" "$J/receipt.json" "$J" ); final=$?
exit $final

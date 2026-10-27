#!/bin/bash
# composite-mdbx-validation-stage/r10 final job status (PREPARED by Claude 1829/1833; NOT run by Claude). Root 1828 #2:
#   final-status.sh RUNTIME_RC JOB_RECEIPT_RC JOB_RECEIPT J_DIR  -> exit code of the production job
# * a NONZERO runtime rc is preserved exactly (its classification: 2 PROBLEMS, 3 REFUSED, 4 CLEANUP-INCOMPLETE, 5 CANCELLED, 7, 8, 124, 137)
# * runtime rc 0 is final 0 ONLY if the job receipt exists, is well-formed, was generated successfully (JRC 0), records rc 0 and every
#   final check true (memory_gate.py evidence); otherwise final 10 (FINAL EVIDENCE FAILED)
# * any evidence failure also writes J_DIR/FINAL-EVIDENCE-FAILED (explicit mark; small)
set -u
R10=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/composite-mdbx-validation-stage/r10
rc=${1:-x}; jrc=${2:-x}; rec=${3:-}; J=${4:-}
[[ "$rc" =~ ^[0-9]+$ ]] || rc=10                                   # an unknown runtime status is never success
[[ "$jrc" =~ ^[0-9]+$ ]] || jrc=1
python3 -I -B $R10/memory_gate.py evidence "$rec" "$rc" "$jrc" > /dev/null 2>&1; ev=$?
if [ "$rc" -ne 0 ]; then final=$rc; elif [ "$ev" -eq 0 ]; then final=0; else final=10; fi
if [ "$ev" -ne 0 ] && [ -n "$J" ] && [ -d "$J" ]; then
  echo "final evidence failed: runtime rc $rc, job receipt rc $jrc, evidence rc $ev -> job exit $final" > "$J/FINAL-EVIDENCE-FAILED"
fi
exit $final

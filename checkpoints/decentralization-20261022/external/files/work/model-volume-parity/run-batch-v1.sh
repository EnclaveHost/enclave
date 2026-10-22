#!/usr/bin/env bash
# ONE queued job (immutable; v1): every model-volume suite in sequence, each step's exit status recorded, the job
# failing if any step failed. JS, then Go/C, then the real-kernel QEMU boots, then the nn runtime exploration.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fails=0
for step in run-js-v1.sh run-go-v2.sh run-qemu-v1.sh explore-nn-v1.sh; do
  echo "=== STEP $step $(date -Is)"
  bash "$here/$step"; rc=$?
  echo "=== STEP $step rc=$rc $(date -Is)"
  [ $rc -eq 0 ] || fails=$((fails + 1))
done
echo "=== BATCH failed_steps=$fails"
[ $fails -eq 0 ]

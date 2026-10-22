#!/usr/bin/env bash
# ONE queued job, the FINAL tree state (immutable): JS, Go/C, the real-kernel boots, the nn runtime + preload.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fails=0
for step in run-js-final.sh run-go-final.sh run-qemu-v2.sh run-nn-v3.sh; do
  echo "=== STEP $step $(date -Is)"
  bash "$here/$step"; rc=$?
  echo "=== STEP $step rc=$rc $(date -Is)"
  [ $rc -eq 0 ] || fails=$((fails + 1))
done
echo "=== BATCH failed_steps=$fails"
[ $fails -eq 0 ]

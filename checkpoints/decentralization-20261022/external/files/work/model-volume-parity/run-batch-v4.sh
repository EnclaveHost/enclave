#!/usr/bin/env bash
# ONE queued job (immutable; v4): the real-kernel boots (the ABI harness fixed), then the nn runtime and the preload
# end to end. Each step's exit status recorded; failing if any failed.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fails=0
for step in run-qemu-v2.sh run-nn-v2.sh; do
  echo "=== STEP $step $(date -Is)"
  bash "$here/$step"; rc=$?
  echo "=== STEP $step rc=$rc $(date -Is)"
  [ $rc -eq 0 ] || fails=$((fails + 1))
done
echo "=== BATCH failed_steps=$fails"
[ $fails -eq 0 ]

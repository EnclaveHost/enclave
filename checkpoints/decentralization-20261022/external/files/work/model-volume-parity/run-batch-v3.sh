#!/usr/bin/env bash
# ONE queued job (immutable; v3): every step in sequence, each step's exit status recorded, failing if any failed.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fails=0
for step in run-js-v3.sh run-go-v3.sh run-qemu-v2.sh build-ggml-probe-v1.sh run-nn-v1.sh; do
  echo "=== STEP $step $(date -Is)"
  bash "$here/$step"; rc=$?
  echo "=== STEP $step rc=$rc $(date -Is)"
  [ $rc -eq 0 ] || fails=$((fails + 1))
done
echo "=== BATCH failed_steps=$fails"
[ $fails -eq 0 ]

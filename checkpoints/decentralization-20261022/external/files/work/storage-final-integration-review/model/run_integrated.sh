#!/bin/bash
# Bounded checks of the integrated membership rules, one at a time: 190 MB address space, 600 s each.
# A run cut by its limit prints "STOPPED ... NOT exhaustive" and its partial result.
cd "$(dirname "$0")"
export PYTHONHASHSEED=0 MODE=dfs FIX=integrated
for spec in legacy:1:-:3 legacy:2:-:2 recorded:1:C,T1:2 recorded:1:C,T1x:2 recorded:0:C,T1,T2:2 recorded:1:C,T1,T2:2; do
  echo "--- $(date -Iseconds) start $spec"
  (ulimit -v 190000; PATHS=traces/dfs-$spec timeout 600 python3 -u ms_model.py "$spec" 2>&1 | grep -v "^    \|^  ->")
  echo "--- $(date -Iseconds) exit ${PIPESTATUS[0]} $spec"
done
echo ALLDONE

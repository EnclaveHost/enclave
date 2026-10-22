#!/bin/bash
# After run_integrated.sh: the proposed F1 fix (FIX=integrated,skip2), bounded the same way.
cd "$(dirname "$0")"
until grep -q ALLDONE integrated-checks.log; do sleep 15; done
export PYTHONHASHSEED=0 MODE=dfs FIX=integrated,skip2
for spec in legacy:1:-:3 legacy:2:-:3; do
  echo "--- $(date -Iseconds) start $spec (skip2)"
  (ulimit -v 190000; PATHS=traces/dfs-skip2-$spec timeout 600 python3 -u ms_model.py "$spec" 2>&1 | grep -v "^    \|^  ->")
  echo "--- $(date -Iseconds) exit ${PIPESTATUS[0]} $spec"
done
echo ALLDONE

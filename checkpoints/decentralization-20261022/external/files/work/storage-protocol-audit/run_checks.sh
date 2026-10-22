#!/bin/bash
# Bounded checks of ms_model.py, one at a time, each under a 190 MB address-space limit and a 15 min time limit.
cd "$(dirname "$0")"
export PYTHONHASHSEED=0 MODE=dfs
run() { (ulimit -v 190000; PATHS=traces/dfs-$1-$2 FIX=$2 timeout 900 python3 ms_model.py "$1" 2>&1 | grep -v "^    \|^  ->"); }
run legacy:1:-:2 ""
run legacy:1:-:2 legacy,sealall
run legacy:2:-:2 legacy,sealall
run recorded:1:C,T1:2 ""
run recorded:1:C,T1x:2 ""
run recorded:0:C,T1,T2:2 ""
run recorded:0:C,T1,T2:2 resolve
run recorded:1:C,T1,T2:2 resolve

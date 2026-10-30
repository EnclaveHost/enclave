#!/bin/bash
cd "$(dirname "$0")"; export TEST_TMP="$PWD/tmp"; rc=0
for m in mutants/*.py; do
  if CHAIN_SERVICE_UNDER_TEST="$PWD/$m" python3 -I mutant_runner.py > "$m.out" 2>&1; then echo "SURVIVED $m"; rc=1; else echo "KILLED $m"; fi
done; exit $rc

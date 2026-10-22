#!/bin/bash
set -uo pipefail; cd "$(dirname "$0")/../native"; rc=0
python3 tools-local-test.py > ../native-local2.out 2>&1 || rc=1
python3 tools/driver-test.py -v > ../native-driver2.out 2>&1 || rc=1
python3 run-native.py > ../native-plan2.out 2>&1 || rc=1
tail -1 ../native-local2.out; grep -E "^Ran|^OK|FAILED" ../native-driver2.out; echo "RC=$rc"; exit $rc

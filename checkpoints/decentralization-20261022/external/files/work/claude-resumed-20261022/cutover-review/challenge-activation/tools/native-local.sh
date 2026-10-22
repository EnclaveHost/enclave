#!/bin/bash
set -uo pipefail; cd "$(dirname "$0")/.."; W="$(cd ../../.. && pwd)"; PW="$W/node-hold-package-20261021/tools/pwsh/pwsh"; rc=0
"$PW" -NoProfile -File tools/static-check.ps1 -Dir native > static.out 2>&1 || rc=1
python3 native/tools/driver-test.py -v > native-driver.out 2>&1 || rc=1
python3 native/run-native.py > native-plan.out 2>&1 || rc=1
cat static.out; grep -E "^Ran|^OK|FAILED" native-driver.out; echo "RC=$rc"; exit $rc

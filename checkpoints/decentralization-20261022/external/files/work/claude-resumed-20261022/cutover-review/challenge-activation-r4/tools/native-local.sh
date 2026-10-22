#!/bin/bash
# r4 native-package local checks (Linux; NOT Windows evidence): parse + reuse, driver fakes, exact texts on real processes, fixture
# helper faults + verbatim sections, plan. Each part's output is kept; RC is non-zero if any part failed.
set -uo pipefail; cd "$(dirname "$0")/.."; W="$(cd ../../.. && pwd)"; export PWSH="$W/node-hold-package-20261021/tools/pwsh/pwsh"; rc=0
python3 tools/repin-native.py --check > repin.out 2>&1 || rc=1
"$PWSH" -NoProfile -File tools/static-check.ps1 -Dir native > static.out 2>&1 || rc=1
python3 -u native/tools/driver-test.py -v > native-driver.out 2>&1 || rc=1
python3 -u native/tools/native-text-test.py -v > native-text.out 2>&1 || rc=1
python3 -u native/tools/local-test.py -v > native-fixture.out 2>&1 || rc=1
python3 native/run-native.py > native-plan.out 2>&1 || rc=1
cat repin.out static.out; for f in native-driver.out native-text.out native-fixture.out; do echo "== $f"; grep -E "^Ran|^OK|FAILED|Error|\.\.\. (FAIL|ERROR)" $f; done; echo "RC=$rc"; exit $rc

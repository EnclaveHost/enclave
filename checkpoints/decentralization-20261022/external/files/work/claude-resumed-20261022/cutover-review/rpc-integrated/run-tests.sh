#!/bin/bash
# rpc-integrated local suite (Linux pwsh mocks / AST / node; NOT Windows evidence)
set -uo pipefail
cd "$(dirname "$0")"; W="$(cd ../../.. && pwd)"
export PWSH="$W/node-hold-package-20261021/tools/pwsh/pwsh"; export N2_BASELINE="$W/node-hold-package-20261021/helper/node-hold-cutover.ps1"
export CUTOVER_SCRIPT="$PWD/helper/node-hold-cutover.ps1"; rc=0
python3 tools/rpc-scenarios-test.py -v > rpc-scenarios.out 2>&1 || rc=1
python3 tools/preparation-test.py -v > preparation.out 2>&1 || rc=1
python3 tools/cutover-mock-test.py -v > suite.out 2>&1 || rc=1
python3 tools/recovery-floor-test.py -v > floor.out 2>&1 || rc=1
python3 tools/review-scenarios-test.py -v > review-scenarios.out 2>&1 || rc=1
"$PWSH" -NoProfile -File tools/stop-proof-test.ps1 -Source helper/node-hold-cutover.ps1 > stop-proof.out 2>&1 || rc=1
node "$PWD/tools/enroll-equality-test.mjs" > enroll-equality.out 2>&1 || rc=1
(cd helper && python3 -m unittest -v test_root_node_hold > ../driver.out 2>&1) || rc=1
python3 native/tools-local-test.py > native-local.out 2>&1 || rc=1
python3 native/tools/driver-test.py -v > native-driver.out 2>&1 || rc=1
for f in rpc-scenarios.out preparation.out suite.out floor.out review-scenarios.out stop-proof.out enroll-equality.out driver.out native-local.out native-driver.out; do echo "== $f"; grep -E "^Ran|^OK|FAILED|passed|LOCAL FIXTURE OK|BASELINE" "$f" | tail -4; done
echo "SUITE_RC=$rc"; exit $rc

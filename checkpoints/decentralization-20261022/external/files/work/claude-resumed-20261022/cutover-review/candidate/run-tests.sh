#!/bin/bash
# cutover-review: full local suite against helper/node-hold-cutover.ps1 (Linux pwsh mocks/AST extraction only; NOT Windows evidence)
set -euo pipefail
cd "$(dirname "$0")"
W="$(cd ../../.. && pwd)"                       # .../wo/work
export PWSH="$W/node-hold-package-20261021/tools/pwsh/pwsh"
export N2_BASELINE="$W/node-hold-package-20261021/helper/node-hold-cutover.ps1"
BASE="${BASELINE:-}"
rc=0
python3 tools/preparation-test.py -v > preparation.out 2>&1 || rc=1
python3 tools/cutover-mock-test.py -v > suite.out 2>&1 || rc=1
python3 tools/recovery-floor-test.py -v > floor.out 2>&1 || rc=1
BASELINE="$BASE" python3 tools/review-scenarios-test.py -v > review-scenarios.out 2>&1 || rc=1
"$PWSH" -NoProfile -File tools/stop-proof-test.ps1 -Source helper/node-hold-cutover.ps1 > stop-proof.out 2>&1 || rc=1
"$PWSH" -NoProfile -File tools/native-path-test.ps1 -Source helper/node-hold-cutover.ps1 > native-path.out 2>&1 || rc=1
for L in 9.7 10.5 13 15; do "$PWSH" -NoProfile -File tools/readiness-cadence-test.ps1 -Source helper/node-hold-cutover.ps1 -ListenerSec $L -Expect 60; done > cadence.out 2>&1 || rc=1
if [ -n "$BASE" ]; then            # negative controls: the same AST checks against the earlier helper (failures expected)
  "$PWSH" -NoProfile -File tools/native-path-test.ps1 -Source "$BASE" > native-path.baseline.out 2>&1 || true
  for L in 9.7 10.5 13 15; do "$PWSH" -NoProfile -File tools/readiness-cadence-test.ps1 -Source "$BASE" -ListenerSec $L; done > cadence.baseline.out 2>&1 || true
fi
for f in preparation.out suite.out floor.out review-scenarios.out stop-proof.out native-path.out cadence.out; do echo "== $f"; tail -4 "$f"; done
echo "SUITE_RC=$rc"; exit $rc

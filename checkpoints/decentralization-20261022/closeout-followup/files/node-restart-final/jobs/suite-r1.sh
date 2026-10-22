#!/usr/bin/env bash
# node-pair-restart local suite (Linux pwsh 7 mocks + real child processes; NOT Windows evidence). Bounded inside the job.
set -uo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/node-restart-final
P=/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh; export PWSH=$P
H=helper/node-pair-restart.ps1; rc=0
python3 tools/compose.py || rc=1
python3 ../../tunnel-g1-watch-fix-20261021/ps_case_lint.py --text $H tools/pair-mock.ps1 tools/swap-prelude.ps1 tools/child-test.ps1 || rc=1
for t in "tools/provenance-test.ps1 -Helper $H -Source source/node-hold-cutover.df2e58f2.ps1 -Provenance helper/provenance.json" \
         "tools/task-budget-test.ps1 -Source $H" "tools/query-failure-test.ps1 -Source $H" "tools/stop-proof-test.ps1 -Source $H" "tools/child-test.ps1 -Helper $H"; do
  echo "=== $t"; timeout -k 5 120 $P -NoProfile -NonInteractive -File $t; r=$?; echo "=== exit=$r"; [ $r -ne 0 ] && rc=1
done
echo "=== pair-test"; timeout -k 5 ${PAIR_BOUND:-480} python3 -u tools/pair-test.py -v ${PAIR_ONLY:-} 2>&1; r=$?; echo "=== pair-test exit=$r"; [ $r -ne 0 ] && rc=1
rm -rf tmp/pair-*
exit $rc

#!/usr/bin/env bash
# Changed helper (exact running set, terminal return, return-pins allowance): compose, lint, provenance, then the pair scenarios
# (the pins/BeforeStop path changed for every scenario, so the full pair set is re-run once; the unchanged unit/child suites
# exercise unchanged functions and are NOT repeated). Bounded inside the job.
set -uo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/node-restart-final
P=/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh; export PWSH=$P
H=helper/node-pair-restart.ps1; rc=0
python3 tools/compose.py || rc=1
python3 ../../tunnel-g1-watch-fix-20261021/ps_case_lint.py --text $H tools/pair-mock.ps1 || rc=1
echo "=== provenance"; timeout -k 5 120 $P -NoProfile -NonInteractive -File tools/provenance-test.ps1 -Helper $H -Source source/node-hold-cutover.df2e58f2.ps1 -Provenance helper/provenance.json || rc=1
echo "=== pair-test"; timeout -k 5 500 python3 -u tools/pair-test.py -v 2>&1; r=$?; echo "=== pair-test exit=$r"; [ $r -ne 0 ] && rc=1
rm -rf tmp/pair-* tmp/clr-debug-pipe-*
exit $rc

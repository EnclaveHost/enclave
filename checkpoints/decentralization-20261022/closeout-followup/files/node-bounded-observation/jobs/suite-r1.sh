#!/usr/bin/env bash
# node-pair-observe.ps1: compose, AST lint, provenance (verbatim df2e58f2 / every other function byte-identical to 7ac1d873),
# then 7ac1's scenario suite re-pointed plus the bounded-observation cases. Bounded inside the job.
set -uo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/node-bounded-observation
P=/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh; export PWSH=$P
H=helper/node-pair-observe.ps1; rc=0
python3 tools/compose.py || rc=1
echo "=== ast case lint"; timeout -k 5 60 $P -NoProfile -NonInteractive -File tools/ast-case-lint.ps1 -Path $H
echo "=== provenance"; timeout -k 5 120 $P -NoProfile -NonInteractive -File tools/provenance-test.ps1 -Helper $H -Source source/node-hold-cutover.df2e58f2.ps1 -Frozen ../node-activate-min/helper/node-pair-activate.ps1 -Provenance helper/provenance.json || rc=1
echo "=== observe-test"; timeout -k 5 560 python3 -u tools/observe-test.py -v 2>&1; r=$?; echo "=== observe-test exit=$r"; [ $r -ne 0 ] && rc=1
rm -rf tmp/act-* tmp/clr-debug-pipe-*
exit $rc

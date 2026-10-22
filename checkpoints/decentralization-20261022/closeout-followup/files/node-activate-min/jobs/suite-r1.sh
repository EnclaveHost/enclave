#!/usr/bin/env bash
# node-pair-activate.ps1: compose, lint (regex + AST), provenance (verbatim df2e58f2 / reused 656d / modified / new), then the
# focused activation scenarios. Bounded inside the job.
set -uo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/node-activate-min
P=/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh; export PWSH=$P
H=helper/node-pair-activate.ps1; rc=0
python3 tools/compose.py || rc=1
echo "=== ast case lint"; timeout -k 5 60 $P -NoProfile -NonInteractive -File tools/ast-case-lint.ps1 -Path $H
timeout -k 5 60 $P -NoProfile -NonInteractive -File tools/ast-case-lint.ps1 -Path tools/pair-mock.ps1
echo "=== provenance"; timeout -k 5 120 $P -NoProfile -NonInteractive -File tools/provenance-test.ps1 -Helper $H -Source source/node-hold-cutover.df2e58f2.ps1 -Frozen ../node-restart-final/helper/node-pair-restart.ps1 -Provenance helper/provenance.json || rc=1
echo "=== activate-test"; timeout -k 5 540 python3 -u tools/activate-test.py -v 2>&1; r=$?; echo "=== activate-test exit=$r"; [ $r -ne 0 ] && rc=1
rm -rf tmp/act-* tmp/clr-debug-pipe-*
exit $rc

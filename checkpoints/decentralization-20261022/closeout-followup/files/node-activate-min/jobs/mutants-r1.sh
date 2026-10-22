#!/usr/bin/env bash
set -uo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/node-activate-min
export PWSH=/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh
timeout -k 5 560 python3 -u jobs/mutants-r1.py; rc=$?
rm -rf tmp/act-* tmp/mutants tmp/clr-debug-pipe-*
exit $rc

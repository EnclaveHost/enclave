#!/usr/bin/env bash
# LEASE DEADLINE proposal: the affected checks only, on the SCRATCH copy (nothing reaches minipc). Serial.
D=/home/steven/Documents/Codex/2026-10-18/wo/work/node-lease-window-review-20261021; P=$D/scratch/work/g4-node-ai-final-20261021
A=/home/steven/Documents/Codex/2026-10-18/wo/work/g4-node-ai-final-20261021
export PWSH=$A/tools/pwsh/pwsh N2_BASELINE=$A/../node-hold-package-20261021/helper/node-hold-cutover.ps1 UNPATCHED=$A/helper/node-hold-cutover.ps1
cd $P || exit 1; rc=0
echo "######## inputs"; sha256sum helper/node-hold-cutover.ps1 helper/root-node-hold.py tools/cutover-mock.ps1 tools/cutover-mock-test.py $UNPATCHED $N2_BASELINE
echo "######## 1. parse: patched cutover + every remote text (pwsh 7.4 parser)"
timeout 300 python3 tools/parse-all.py || rc=1
echo "######## 2. helper unit tests (fakes)"
( cd helper && timeout 300 python3 -m unittest -v test_root_node_hold 2>&1 ) | grep -E "\.\.\. |^Ran|^OK|FAILED|Error|Traceback|assert" ; [ ${PIPESTATUS[0]} -eq 0 ] || rc=1
echo "######## 3. mock scenario suite: 27 prior + LeaseDeadline (negative control UNPATCHED inside)"
( timeout 1200 python3 -m unittest -v tools/cutover-mock-test.py 2>&1 ) | grep -E "\.\.\. |^Ran|^OK|FAILED|^FAIL:|^ERROR:|N2 baseline|UNPATCHED|Error|assert" ; [ ${PIPESTATUS[0]} -eq 0 ] || rc=1
echo "RESULT rc=$rc"; exit $rc

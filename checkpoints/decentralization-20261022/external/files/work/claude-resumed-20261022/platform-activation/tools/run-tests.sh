#!/bin/bash
# platform-activation suite (Linux pwsh 7 mocks + node; NOT Windows evidence). Usage: tools/run-tests.sh <tag>
# Outputs tools/logs/<tag>.{gate,activation,runner,mutants}.out. ONE job, one queue slot (512).
set -u
cd "$(dirname "$0")/.."
tag="$1"; mkdir -p tools/logs
export PWSH=/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh
rc=0
node --test tools/test_gate_proof.mjs > "tools/logs/$tag.gate.out" 2>&1 || rc=1
python3 tools/test_activation.py -v > "tools/logs/$tag.activation.out" 2>&1 || rc=1
python3 tools/test_runner.py -v > "tools/logs/$tag.runner.out" 2>&1 || rc=1
python3 tools/test_installer_fix.py -v > "tools/logs/$tag.installer.out" 2>&1 || rc=1
python3 tools/mutants.py > "tools/logs/$tag.mutants.out" 2>&1 || rc=1
grep -E "^# (pass|fail)" "tools/logs/$tag.gate.out"; for f in activation runner installer; do tail -3 "tools/logs/$tag.$f.out"; done; tail -1 "tools/logs/$tag.mutants.out"
echo "SUITE_RC=$rc"; exit $rc

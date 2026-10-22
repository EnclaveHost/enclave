#!/bin/bash
# derived activation suites (Linux pwsh 7 mocks + node; NOT Windows evidence): run-suite.sh <a|b> <tag>
set -u; cd "$(dirname "$0")"; export PWSH=/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh; rc=0
if [ "$1" = a ]; then
  node --test tools/test_gate_proof.mjs > "logs/$2.gate.out" 2>&1 || rc=1
  python3 -u tools/test_activation.py -v > "logs/$2.activation.out" 2>&1 || rc=1
  python3 -u tools/mutants.py > "logs/$2.mutants.out" 2>&1 || rc=1
else python3 -u tools/test_runner.py -v > "logs/$2.runner.out" 2>&1 || rc=1; fi
echo "SUITE $1 rc=$rc"; exit $rc

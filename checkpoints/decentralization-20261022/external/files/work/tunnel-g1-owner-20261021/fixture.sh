#!/bin/bash
# local only: plan (sizes) + lint + self-test of the proposed copy. No remote call.
set -u; cd "$(dirname "$0")"; C=../tunnel-native-task-canary-20261021
echo "== 1. local plan, final manifest"; G1_SIZES=1 python3 g1_canary.py plan --manifest $C/manifests/FINAL-754d5a70-ec077c11.json --offset-min 2; echo "rc=$?"
R=$(ls runs); python3 -c "
import json;p=json.load(open('runs/$R/PLAN.json'));e=p['encoded'];print({k:e[k] for k in ('watch','parse:watch','register-n','pre','parse:pre')},'max',max(e.values()),'limit',p['limit'])"
echo "== 2. lint every planned script"; python3 ps_case_lint.py runs/$R/scripts.json; echo "rc=$?"
mkdir -p evidence/local-plans && mv runs/$R evidence/local-plans/$R-LOCAL-DO-NOT-RUN && rmdir runs
echo "== 3. self-test (final pair)"
G1_TEST_CONTROLLER=$PWD/$C/final-inputs/tunnel_install.754d5a70.py G1_TEST_RECEIVER=$PWD/$C/final-inputs/tunnel-receiver.ec077c11.ps1 python3 test_g1_canary.py 2>&1 | grep -v "\.\.\. ok$"

#!/bin/bash
# local only. No remote call.
set -u; cd "$(dirname "$0")"; C=../tunnel-native-task-canary-20261021
echo "== 1. trace_validate plan (sizes, script sha)"; python3 trace_validate.py plan; echo "rc=$?"
echo "== 2. trace_validate tests"; python3 test_trace_validate.py 2>&1 | grep -v "\.\.\. ok$"
echo "== 3. G1 local plan (with a VALID sample validation) + lint"
python3 -c "import json,test_trace_validate as T;open('evidence/sample-valid.json','w').write(json.dumps({'result':T.GOOD}))"
G1_SIZES=1 python3 g1_canary.py plan --manifest $C/manifests/FINAL-754d5a70-ec077c11.json --offset-min 2 --trace-validation evidence/sample-valid.json; echo "rc=$?"
R=$(ls runs); python3 -c "
import json;p=json.load(open('runs/$R/PLAN.json'));e=p['encoded'];print({k:e[k] for k in e if 'trace' in k or 'watch' in k},'max',max(e.values()),'limit',p['limit'],'traceValidation',p['traceValidation']['VALID'])"
python3 ps_case_lint.py runs/$R/scripts.json; echo "rc=$?"
mkdir -p evidence/local-plans && mv runs/$R evidence/local-plans/$R-LOCAL-SAMPLE-VALIDATION-DO-NOT-RUN && rmdir runs; rm evidence/sample-valid.json
echo "== 4. G1 self-test (final pair)"
G1_TEST_CONTROLLER=$PWD/$C/final-inputs/tunnel_install.754d5a70.py G1_TEST_RECEIVER=$PWD/$C/final-inputs/tunnel-receiver.ec077c11.ps1 python3 test_g1_canary.py 2>&1 | grep -v "\.\.\. ok$"

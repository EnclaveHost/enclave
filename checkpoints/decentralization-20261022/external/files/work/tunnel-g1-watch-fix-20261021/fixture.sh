#!/bin/bash
# local only: lint + plan + self-test of the patched copy (no remote call)
set -u; cd "$(dirname "$0")"; W=..
echo "== 1. lint: the ACTIVE run's planned scripts (g13f5b009e, copied read-only)"; python3 ps_case_lint.py evidence/g13f5b009e.scripts.json; echo "rc=$?"
echo "== 2. local plan with the PATCHED copy on the final manifest, then lint it"
python3 g1_canary.py plan --manifest $W/tunnel-native-task-canary-20261021/manifests/FINAL-754d5a70-ec077c11.json --offset-min 2; echo "rc=$?"
R=$(ls runs); python3 ps_case_lint.py runs/$R/scripts.json; echo "rc=$?"
mkdir -p evidence/local-plans && mv runs/$R evidence/local-plans/$R-LOCAL-DO-NOT-RUN && rmdir runs
echo "== 3. info: the frozen controller's change-step scripts + launcher text, and the receiver"
python3 - <<'PY'
import importlib.util, json, sys
sys.path.insert(0, "."); import ps_case_lint
s = importlib.util.spec_from_file_location("ti", "../tunnel-native-task-canary-20261021/final-inputs/tunnel_install.754d5a70.py"); ti = importlib.util.module_from_spec(s)
try: s.loader.exec_module(ti); got = ti.built_scripts("x" * 16)
except Exception as e: print("controller not loadable here:", e); got = []
print(json.dumps({"controllerScripts": len(got), "collisions": {i: c for i, t in enumerate(got) if (c := ps_case_lint.collisions(t))}}))
PY
python3 ps_case_lint.py --text $W/tunnel-native-task-canary-20261021/final-inputs/tunnel-receiver.ec077c11.ps1; echo "rc=$?"
echo "== 4. self-test of the patched copy (final pair)"
G1_TEST_CONTROLLER=$PWD/$W/tunnel-native-task-canary-20261021/final-inputs/tunnel_install.754d5a70.py \
G1_TEST_RECEIVER=$PWD/$W/tunnel-native-task-canary-20261021/final-inputs/tunnel-receiver.ec077c11.ps1 python3 test_g1_canary.py 2>&1 | grep -v "\.\.\. ok$"

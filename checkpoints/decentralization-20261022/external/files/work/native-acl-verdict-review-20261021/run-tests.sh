#!/usr/bin/env bash
# native-acl-verdict-review: local only (pure adjudication, pwsh 7.4 on temp dirs, fake transport). Never remote or native.
cd /home/steven/Documents/Codex/2026-10-18/wo/work/native-acl-verdict-review-20261021 || exit 1; rc=0
echo "######## 1. adjudication of the captured receipt + negative controls"
timeout 120 python3 -m unittest -v test_adjudicate 2>&1 | grep -E "\.\.\. |^Ran|^OK|FAILED|Error|^FAIL" ; [ ${PIPESTATUS[0]} -eq 0 ] || rc=1
echo "######## 2. the EXACT old/new verdict lines + the fixture's Left() in pwsh 7.4"
timeout 180 python3 -m unittest -v verdict_pwsh_test 2>&1 | grep -vE "^\s*$" ; [ ${PIPESTATUS[0]} -eq 0 ] || rc=1
echo "######## 3. fixture-v3 driver: the 11 reviewed v2 driver tests (parse, flow, cleanup proof, plan mode) on the re-pinned copy"
( cd fixture-v3 && timeout 300 python3 -m unittest -v test_local_v2 2>&1 ) | grep -E "\.\.\. |^Ran|^OK|FAILED|Error" ; [ ${PIPESTATUS[0]} -eq 0 ] || rc=1
echo "######## 4. fixture-v3 plan mode as root runs it (no remote; pins)"
( cd / && timeout 60 python3 /home/steven/Documents/Codex/2026-10-18/wo/work/native-acl-verdict-review-20261021/fixture-v3/root-run-acl-fixture.py ) || rc=1
test ! -e fixture-v3/runs || { echo "plan mode wrote runs/"; rc=1; }
echo "RESULT rc=$rc"; exit $rc

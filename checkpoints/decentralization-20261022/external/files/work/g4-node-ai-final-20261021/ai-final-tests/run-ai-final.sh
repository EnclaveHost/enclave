#!/usr/bin/env bash
# G4 + AI final package: ONLY the affected checks (local; parse/mock/fakes; nothing reaches minipc). Serial; queue 256.
P=/home/steven/Documents/Codex/2026-10-18/wo/work/g4-node-ai-final-20261021; cd $P || exit 1; rc=0
echo "######## 1. ProtectedTemp/CasWrite/Sha byte-identical to the native-proven extents (new + frozen original)"
timeout 120 python3 ai-final-tests/proven-functions.py || rc=1
echo "######## 2. parse: cutover script + every remote text, incl. the NEW ACLS read (pwsh 7.4 parser)"
timeout 300 python3 tools/parse-all.py || rc=1
echo "######## 3. helper unit tests (fakes; 8 tests incl. the AI refusals and every remote text <= 7900)"
( cd helper && timeout 300 python3 -m unittest -v test_root_node_hold 2>&1 ) | grep -E "\.\.\. |^Ran|^OK|FAILED|Error|Traceback|assert" ; [ ${PIPESTATUS[0]} -eq 0 ] || rc=1
echo "######## 4. mock scenario suite on the NEW cutover (26 prior + the AI precondition)"
( timeout 900 python3 -m unittest -v tools/cutover-mock-test.py 2>&1 ) | grep -E "\.\.\. |^Ran|^OK|FAILED|^FAIL:|^ERROR:|N2 baseline" ; [ ${PIPESTATUS[0]} -eq 0 ] || rc=1
echo "######## 5. negative control: the AI scenario against the FROZEN 2984c6f2 must FAIL (it has no precondition)"
CUTOVER_SCRIPT=$P/../g4-node-final-package-20261021/helper/node-hold-cutover.ps1 timeout 300 python3 - <<'PY'
import importlib.util, sys, unittest
s = importlib.util.spec_from_file_location("cmt", "tools/cutover-mock-test.py"); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
print("frozen script:", m.SCRIPT)
r = unittest.TextTestRunner(verbosity=1, stream=sys.stdout).run(unittest.defaultTestLoader.loadTestsFromTestCase(m.AclPrecondition))
ok = len(r.failures) == 1 and not r.errors
print("negative control:", "AS EXPECTED (frozen script does not refuse a non-AI DACL)" if ok else "UNEXPECTED"); sys.exit(0 if ok else 1)
PY
[ $? -eq 0 ] || rc=1
echo "RESULT rc=$rc"; exit $rc

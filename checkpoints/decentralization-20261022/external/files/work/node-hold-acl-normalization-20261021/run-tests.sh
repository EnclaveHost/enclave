#!/usr/bin/env bash
# focused: the precondition patch on copies only (no package/9d file touched)
D=/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-acl-normalization-20261021; PW=$D/../node-hold-package-20261021/tools/pwsh/pwsh
echo "######## flag regex (the inserted pwsh expression) on sample SDDLs"
$PW -NoProfile -Command "foreach(\$s in 'O:SYG:SYD:AI(A;ID;FA;;;BA)','O:BAG:BUD:PAI(A;;FA;;;SY)','O:BAG:BUD:(A;ID;FA;;;SY)','O:BAG:BUD:P(A;;FA;;;SY)','O:BAG:BUD:AR(A;;FA;;;SY)','O:BAG:BUD:ARAI(A;ID;FA;;;SY)'){\$df=[regex]::Match(\$s,'D:([A-Z]*)\(').Groups[1].Value;'{0} -> {1} {2}' -f \$s,\$df,(\$(if(\$df -notmatch 'AI'){'REFUSE'}else{'ok'}))}"
echo "######## mock scenarios (proposed adb30630): precondition + full regression"
cd $D && CUTOVER_SCRIPT=$D/proposed/node-hold-cutover.ps1 timeout 600 python3 -m unittest -v tools/cutover-mock-test.py 2>&1 | grep -E "\.\.\. |^Ran|^OK|FAILED|Error"
echo "######## controller unit tests (proposed controller in pkgtest)"
cd $D/.. && timeout 300 python3 -m unittest -v node-hold-acl-normalization-20261021/pkgtest/helper/test_root_node_hold.py 2>&1 | grep -E "\.\.\. |^Ran|^OK|FAILED|Error"
echo "######## encoded size of the patched preflight text, 9d's g4 copy"
cd $D && python3 - <<'PY'
import importlib.util,base64,pathlib
for d in ("pkgtest/helper","g4copy"):
    p=pathlib.Path(d)/"root-node-hold.py"; src=p.read_text()
    ns={}; i=src.index("CFGS = U"); j=src.index("\n",src.index(".replace(\"CFGX\", CFG)",i))
    head=src[:src.index("PF = r")]; exec(compile(src[src.index("U = "):src.index("\n",src.index("U = "))],"u","exec"),ns); ns["CFG"]=r"C:\ProgramData\Enclave\network\privacy-config.json"
    exec(compile(src[i:j],"c","exec"),ns)
    t=importlib.util.spec_from_file_location("t","nucbox-tls-20261021/root-activate-reviewed.py");m=importlib.util.module_from_spec(t);t.loader.exec_module(m)
    a=src.index("ACLS = U"); exec(compile(src[a:src.index("\n",a)],"a","exec"),ns)
    for k in ("CFGS","ACLS"): print(d,k,"encoded",len(base64.b64encode((m.HEAD.replace("SECS","90")+ns[k]).encode("utf-16-le"))),"(limit 7900)")
PY

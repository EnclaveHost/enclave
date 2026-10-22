#!/usr/bin/env bash
D=/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-acl-normalization-20261021; PW=$D/../node-hold-package-20261021/tools/pwsh/pwsh
echo "######## parse: patched cutover scripts (605 base + 9d copy)"
for f in $D/proposed/node-hold-cutover.ps1 $D/g4copy/node-hold-cutover.ps1; do $PW -NoProfile -Command "\$e=\$null;\$null=[System.Management.Automation.Language.Parser]::ParseFile('$f',[ref]\$null,[ref]\$e);'$(basename $(dirname $f)) parse errors: '+\$e.Count"; done
echo "######## fixture v2 driver/local tests"
cd $D/.. && timeout 300 python3 -m unittest -v node-hold-acl-normalization-20261021/fixture-v2/test_local_v2.py 2>&1 | grep -E "\.\.\. |^Ran|^OK|FAILED|Error"

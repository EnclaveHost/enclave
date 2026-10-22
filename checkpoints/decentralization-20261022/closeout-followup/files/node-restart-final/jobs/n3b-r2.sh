#!/usr/bin/env bash
# the strengthened pins test: green on the real helper, and it must now FAIL on N3b for the right reason
set -uo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/node-restart-final
export PWSH=/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh
K=test_the_running_set_must_be_exactly_expectedIds_at_the_pins
echo "=== real"; timeout -k 5 120 python3 -u tools/pair-test.py -k $K 2>&1 | tail -3; real=${PIPESTATUS[0]}
F=helper/node-pair-restart.ps1; cp $F $F.mutant-orig; trap 'cp $F.mutant-orig $F; rm -f $F.mutant-orig; rm -rf tmp/pair-*' EXIT
python3 - <<'PY'
p='helper/node-pair-restart.ps1'; s=open(p).read(); a="if ($rs) { $why += $rs } }"; assert s.count(a)==1; open(p,'w').write(s.replace(a,"if ($false) { $why += $rs } }"))
PY
echo "=== N3b"; timeout -k 5 120 python3 -u tools/pair-test.py -k $K 2>&1 | grep -E "AssertionError|Ran|OK|FAILED" | cut -c1-300
exit $real

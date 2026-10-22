#!/bin/bash
# three mutants of the corrected scripts, each must FAIL the suite; then the REAL suite re-stages the real bytes
B=/home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021
for m in private-check-off acl-restore-off journal-guard-off; do
  rm -rf $B/respawn-mutant/run && mkdir -p $B/respawn-mutant/run && cp $B/respawn-activation/{activate.py,test-respawn.py,cron-respawn.ps1,node-restart.ps1,bundle-swap.ps1} $B/respawn-mutant/run/
  python3 - "$m" <<'PY'
import sys; m=sys.argv[1]; d='/home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021/respawn-mutant/run/'
for f in ('cron-respawn.ps1','bundle-swap.ps1'):
    s=open(d+f).read()
    if m=='private-check-off': a="if (-not (IsPrivate $PRIV $true)) { throw 'PRIVATE_DIR_NOT_PRIVATE' }"; b="if ($false) { throw 'PRIVATE_DIR_NOT_PRIVATE' }"
    elif m=='acl-restore-off': a="Set-Acl -LiteralPath $p -AclObject $acl0; return"; b="return"
    else: a="$j0.state -eq 'started' -and $Mode -ne 'rollback'"; b="$false"
    assert s.count(a)>=1,(m,f); open(d+f,'w').write(s.replace(a,b))
PY
  # the mutant's own probe path: ../probe.py relative to run/ -> respawn-mutant/probe.py
  cp $B/probe.py $B/respawn-mutant/probe.py
  (cd $B/respawn-mutant/run && timeout 2000 python3 test-respawn.py > ../mutant-$m.out 2>&1); echo "mutant $m rc=$? $(tail -1 $B/respawn-mutant/mutant-$m.out | cut -c1-330)"
done
cd $B/respawn-activation && timeout 2000 python3 test-respawn.py > test-respawn.out 2>&1; echo "real rc=$? $(tail -1 test-respawn.out)"

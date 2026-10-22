#!/bin/bash
# mutation controls for test-accept.py: each mutant of accept-decide.py must make the fixture tests FAIL
set -u
cd /home/steven/Documents/Codex/2026-10-18/wo/work/ens-public-site-20261021/publisher
for m in incomplete-retry ignore-rc empty-routes trust-row-expected; do
  rm -rf accept-mutant && mkdir accept-mutant && cp composed-release/{accept-decide.py,accept-release.sh,test-accept.py} accept-mutant/
  python3 - "$m" <<'PY'
import sys; m=sys.argv[1]; p='accept-mutant/accept-decide.py'; s=open(p).read()
rep={'incomplete-retry':("if incomplete: return 'fail'","if incomplete: return 'retry'"),
     'ignore-rc':("if rc not in ok_rcs: return None","if False: return None"),
     'trust-row-expected':("trust, st, got = trusted_expected(M, r['path']), _int(r.get('status')), r.get('sha256')","trust, st, got = r.get('expected') if isinstance(r.get('expected'), dict) and r.get('expected') else trusted_expected(M, r['path']), _int(r.get('status')), r.get('sha256')"),
     'empty-routes':("if not isinstance(res, list) or not res: return 'fail', ['no results']","if not isinstance(res, list): return 'fail', ['no results']\n    if not res: return 'ok', []")}[m]
assert s.count(rep[0])==1; open(p,'w').write(s.replace(*rep))
PY
  timeout 300 python3 accept-mutant/test-accept.py > /tmp/accept-mutant.out 2>&1; rc=$?
  echo "mutant $m: test rc=$rc ($(tail -1 /tmp/accept-mutant.out | cut -c1-200))"
done
rm -rf accept-mutant /tmp/accept-mutant.out

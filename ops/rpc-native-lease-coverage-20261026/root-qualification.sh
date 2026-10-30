#!/bin/bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
python3 - <<'PY'
from pathlib import Path
import subprocess,re,json
s=Path('derivation-lease-coverage-stage/r2')
before=set((s/'logs').glob('run-*')) if (s/'logs').exists() else set()
rc=subprocess.call(['bash',str(s/'jobs/build-test.sh')])
after=set((s/'logs').glob('run-*'))-before
assert len(after)==1,sorted(map(str,after))
out=after.pop()
print('ROOT actual build evidence:',out,flush=True)
if rc: raise SystemExit(rc)
text=(out/'test.txt').read_text()
assert re.search(r'test result: ok\. 14 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out',text), 'not exact fourteen executed tests'
assert (out/'lock.txt').read_text().strip()=='Cargo.lock unchanged f122da76'
assert (out/'binary.sha256').is_file() and len((out/'binary.sha256').read_text().split()[0])==64
(out/'ROOT-VERDICT.json').write_text(json.dumps({'ok':True,'tests':14,'ignored':0,'filtered':0,'lockUnchanged':True,'binary':(out/'binary.sha256').read_text().strip(),'mainnetProof':False},indent=2)+'\n')
print('ROOT exact14, unchanged lock, built binary confirmed',flush=True)
PY

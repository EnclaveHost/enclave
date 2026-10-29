from pathlib import Path
import os,subprocess,json,hashlib
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
m=json.loads((p/'regression-input-pins.json').read_text())
check=lambda:all(hashlib.sha256(Path(x).read_bytes()).hexdigest()==h for x,h in m.items())
assert check(),'regression input drift'
prior=p.parent/'lifecycle-host-authority-review-r2/test'
files=[x for x in sorted((p/'test').glob('*.test.mjs')) if x.name!='root-incarnation-acceptance.test.mjs']+[x for x in sorted(prior.glob('*.test.mjs')) if x.name not in {'lifecycle-host-authority.test.mjs','generate-lifecycle-host-candidate.test.mjs'}]
with (p/'regressions.log').open('x') as log:
 r=subprocess.run(['node','--test','--test-concurrency=1','--import',str(p/'test/helpers/baseline.mjs'),*map(str,files)],stdout=log,stderr=subprocess.STDOUT,timeout=180)
assert check(),'regression input drift after test'
(p/'regressions.rc').write_text(str(r.returncode)+'\n')
raise SystemExit(r.returncode)

from pathlib import Path
import subprocess,os,json,hashlib,shutil
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
m=json.loads((p/'input-pins.json').read_text())
check=lambda: all(hashlib.sha256(Path(x).read_bytes()).hexdigest()==h for x,h in m.items())
assert check(),'reviewed input drift'
base=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028/lifecycle-schema3-host-composition-r1/src/network')
with (p/'generate.log').open('x') as f:
 r=subprocess.run(['node',str(p/'author-snapshot/src/tools/generate-lifecycle-host-registry-host-candidate.mjs'),str(base),str(p/'generated-host')],stdout=f,stderr=subprocess.STDOUT,timeout=25)
assert r.returncode==0,'generator failed; tests not started'
for f in (p/'generated-host').glob('*.mjs'):
 subprocess.run(['node','--check',str(f)],check=True,timeout=10)
 shutil.copy2(f,p/'src/network'/f.name)
shutil.copy2(p/'author-snapshot/src/network/lifecycle-host-incarnation-journal.mjs',p/'src/network/lifecycle-host-incarnation-journal.mjs')
with (p/'tests.log').open('x') as f:
 r=subprocess.run(['node','--test','--test-concurrency=1','--import',str(p/'test/helpers/baseline.mjs'),str(p/'test/root-incarnation-acceptance.test.mjs')],stdout=f,stderr=subprocess.STDOUT,timeout=60)
assert check(),'input drift after test'
(p/'tests.rc').write_text(str(r.returncode)+'\n')
raise SystemExit(r.returncode)

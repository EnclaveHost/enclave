from pathlib import Path
import os,subprocess,hashlib,json,shutil
p=Path(__file__).resolve().parent;u=p.parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
pins=json.loads((p/'input-pins.json').read_text());check=lambda:all(hashlib.sha256(Path(n).read_bytes()).hexdigest()==h for n,h in pins.items())
assert check()
with (p/'generation.log').open('x') as f:r=subprocess.run(['node',str(p/'src/tools/generate-host-authority-permit-candidates.mjs'),str(u/'host-permit-generator-preflight-r1/inputs'),str(p/'generated')],stdout=f,stderr=subprocess.STDOUT,timeout=25)
assert r.returncode==0
for name in ['deployment-serving-permit.mjs','deployment-permit-gate.mjs','deployment-lifecycle-witness.mjs','deployment-isolation-runtime.mjs']:shutil.copy2(p/'generated'/name,p/'protocol-tree/network'/name)
with (p/'tests.log').open('x') as f:r=subprocess.run(['unshare','-Urn','node','--test','--experimental-test-isolation=none','--test-concurrency=1',str(p/'protocol-tree/test/host-authority-permit.test.mjs'),str(p/'protocol-tree/test/root-permit-integration.test.mjs')],stdout=f,stderr=subprocess.STDOUT,timeout=100)
assert check()
(p/'tests.rc').write_text(str(r.returncode)+'\n')
raise SystemExit(r.returncode)

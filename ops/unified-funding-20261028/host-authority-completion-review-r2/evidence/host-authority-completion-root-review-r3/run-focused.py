from pathlib import Path
import os,subprocess,hashlib,json,shutil
p=Path(__file__).resolve().parent;u=p.parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
pins=json.loads((p/'focused-input-pins.json').read_text())
def check():
 for n,h in pins.items():assert hashlib.sha256(Path(n).read_bytes()).hexdigest()==h,n
check()
with (p/'generation.log').open('x') as f:r=subprocess.run(['node',str(p/'candidate/src/tools/generate-host-authority-permit-candidates.mjs'),str(u/'host-permit-generator-preflight-r1/inputs'),str(p/'generated')],stdout=f,stderr=subprocess.STDOUT,timeout=25)
assert r.returncode==0,'generation failed'
check()
for n in ['deployment-serving-permit.mjs','deployment-permit-gate.mjs','deployment-lifecycle-witness.mjs','deployment-isolation-runtime.mjs']:shutil.copy2(p/'generated'/n,p/'protocol-tree/network'/n)
commands=[['--test','--experimental-test-isolation=none','--test-concurrency=1',str(p/'protocol-tree/test/host-authority-permit.test.mjs'),str(p/'protocol-tree/test/root-completion-protocol.test.mjs'),str(p/'protocol-tree/test/root-permit-integration.test.mjs'),str(p/'protocol-tree/final-await.test.mjs')]]
with (p/'focused-tests.log').open('x') as f:r=subprocess.run(['unshare','-Urn','node',*commands[0]],stdout=f,stderr=subprocess.STDOUT,timeout=180)
# Generated overlays deliberately replace four copied baselines. All AUTHOR inputs and TEST sources remain unchanged.
for n,h in pins.items():
 if '/protocol-tree/network/' in n and Path(n).name in ['deployment-serving-permit.mjs','deployment-permit-gate.mjs','deployment-lifecycle-witness.mjs','deployment-isolation-runtime.mjs']:continue
 assert hashlib.sha256(Path(n).read_bytes()).hexdigest()==h,n
(p/'focused-tests.rc').write_text(str(r.returncode)+'\n')
raise SystemExit(r.returncode)

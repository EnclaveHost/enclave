from pathlib import Path
import subprocess,json,time,hashlib
p=Path(__file__).resolve().parent
s=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source')
head='69d6d76af0d2e8515fdc63252e2770da05231e5e'
pins=json.loads((p.parent/'rpc-definition-closure-fix-source-r1/SOURCE-PINS.json').read_text())
for n,h in pins.items():assert hashlib.sha256((s/n).read_bytes()).hexdigest()==h,n
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(s.parent/'unified-funding-20261028/rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-384>=max(27648,a['floorMiB'])
(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')

for workflow in ('rpc-startup-controller.yml','rpc-owned-definition.yml'):
 listing=subprocess.run(['/usr/sbin/gh','run','list','--repo','EnclaveHost/enclave','--workflow',workflow,'--limit','5','--json','databaseId,status,headSha'],capture_output=True,text=True,timeout=20,check=True)
 rows=json.loads(listing.stdout)
 assert all(x['status']=='completed' for x in rows),'Existing live run; do not dispatch'
 name=workflow.removesuffix('.yml')
 (p/(name+'-PRIOR.json')).write_text(json.dumps(rows)+'\n')
 with (p/(name+'-INTENT.json')).open('x') as f:json.dump({'at':time.time(),'head':head,'workflow':workflow,'noRetry':True},f);f.flush();__import__('os').fsync(f.fileno())
 try:
  r=subprocess.run(['/usr/sbin/gh','workflow','run',workflow,'--repo','EnclaveHost/enclave','--ref','main','-f','expected_sha='+head],capture_output=True,text=True,timeout=30)
  (p/(name+'-DISPATCH.json')).write_text(json.dumps({'head':head,'rc':r.returncode,'stdout':r.stdout[:4096],'stderr':r.stderr[:4096]})+'\n')
  assert r.returncode==0
 except subprocess.TimeoutExpired:
  (p/(name+'-UNKNOWN.json')).write_text(json.dumps({'unknown':True,'noRetry':True})+'\n');raise

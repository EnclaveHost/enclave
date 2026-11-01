from pathlib import Path
import subprocess,json,hashlib,time,re
p=Path(__file__).resolve().parent;s=p.parent.parent/'source'
pins=json.loads((p/'PINS.json').read_text())
def verify():
 for n,h in pins.items():
  assert hashlib.sha256((s/n).read_bytes()).hexdigest()==h,n
  assert hashlib.sha256((p/'frozen'/n).read_bytes()).hexdigest()==h,n
verify()
with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'once':True},f)
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-640>=max(27648,a['floorMiB'])
(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
cmd=['/usr/bin/bwrap','--die-with-parent','--unshare-user','--unshare-net','--ro-bind','/','/','--dev','/dev','--proc','/proc','--tmpfs','/tmp','--chdir',str(p/'frozen/rpc/native'),'/usr/bin/env','-i','PATH=/usr/bin:/bin','HOME=/tmp','PYTHONDONTWRITEBYTECODE=1','/usr/bin/python3','-B','-m','unittest','discover','-s','.','-p','test_*.py','-v']
(p/'TEST-COMMAND.json').write_text(json.dumps(cmd)+'\n');start=time.monotonic()
with (p/'TEST.log').open('x') as log:r=subprocess.run(cmd,stdout=log,stderr=log,timeout=90)
verify();log=(p/'TEST.log').read_text();count=re.findall(r'Ran (\d+) tests?',log)
result={'exit':r.returncode,'elapsed':time.monotonic()-start,'tests':int(count[-1]) if count else None,'pins':len(pins),'pinsUnchanged':True,'nativeClientsExecuted':False,'rpcReady':False}
(p/'RESULT.json').write_text(json.dumps(result)+'\n');print(json.dumps(result));assert r.returncode==0

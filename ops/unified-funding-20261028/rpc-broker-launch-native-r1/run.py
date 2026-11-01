from pathlib import Path
import json,hashlib,subprocess,time
p=Path(__file__).resolve().parent;s=p.parent.parent/'source';pins=json.loads((p/'PINS.json').read_text())
def verify():
 for n,h in pins.items():
  assert hashlib.sha256((s/n).read_bytes()).hexdigest()==h,n
  assert hashlib.sha256((p/'frozen'/n).read_bytes()).hexdigest()==h,n
verify()
with (p/'ATTEMPT.json').open('x') as f:json.dump({'once':True,'at':time.time(),'nativeInertBrokerOnly':True},f)
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-640>=max(27648,a['floorMiB'])
(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
start=time.monotonic()
r=subprocess.run(['/usr/bin/python3','-B',str(p/'frozen/test/rpc-server/qualify_broker_launch.py'),str(p/'SPEC.json')],timeout=20)
verify();(p/'RESULT.json').write_text(json.dumps({'exit':r.returncode,'elapsed':time.monotonic()-start,'pinsUnchanged':True,'pins':len(pins),'production':False})+'\n');assert r.returncode==0

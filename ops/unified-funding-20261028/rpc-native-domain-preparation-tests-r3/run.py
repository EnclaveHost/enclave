from pathlib import Path
import json,hashlib,subprocess,time,os
p=Path(__file__).resolve().parent;s=p.parent.parent/'source';pins=json.loads((p/'PINS.json').read_text())
def verify():
 for n,h in pins.items():
  assert hashlib.sha256((p/'frozen'/n).read_bytes()).hexdigest()==h,n
  assert hashlib.sha256((s/n).read_bytes()).hexdigest()==h,n
verify()
with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'once':True},f)
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and a['unreadUnits']==0 and a['availableMiB']-a['pendingMiB']-640>=max(27648,a['floorMiB'])
(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
cmd=['/usr/bin/bwrap','--die-with-parent','--unshare-user','--uid','0','--gid','0','--unshare-net','--ro-bind','/','/','--dev','/dev','--proc','/proc','--tmpfs','/tmp','--bind',str(p/'cache'),str(p/'cache'),'--bind',str(p/'tmp'),str(p/'tmp'),'--bind',str(p/'output'),str(p/'output'),'--chdir',str(p/'frozen/isolation/m3'),'/usr/bin/env','-i','PATH=/usr/bin:/bin','HOME=/tmp','GOMAXPROCS=1','CGO_ENABLED=0','GOTOOLCHAIN=local','GOPROXY=off','GOSUMDB=off','GOCACHE='+str(p/'cache'),'GOTMPDIR='+str(p/'tmp'),'/usr/bin/go','test','-p','1','-count=1','-timeout=90s','-json','./rpcdomain']
(p/'TEST-COMMAND.json').write_text(json.dumps(cmd)+'\n');start=time.monotonic()
with (p/'TEST.jsonl').open('x') as log:r=subprocess.run(cmd,stdout=log,stderr=log,timeout=120)
verify();events=[]
for line in (p/'TEST.jsonl').read_text().splitlines():
 try:events.append(json.loads(line))
 except:pass
result={'exit':r.returncode,'elapsed':time.monotonic()-start,'pass':sum(x.get('Action')=='pass' and 'Test' in x for x in events),'fail':sum(x.get('Action')=='fail' for x in events),'sourcePins':len(pins),'pinsUnchanged':True,'nativeRuntimeQualified':False,'appDeployed':False}
(p/'RESULT.json').write_text(json.dumps(result)+'\n');print(json.dumps(result));assert r.returncode==0

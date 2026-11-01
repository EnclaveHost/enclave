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
cmd=['/usr/bin/bwrap','--die-with-parent','--unshare-user','--unshare-net','--ro-bind','/','/','--dev','/dev','--proc','/proc','--tmpfs','/tmp','--bind',str(p/'cache'),str(p/'cache'),'--bind',str(p/'tmp'),str(p/'tmp'),'--bind',str(p/'output'),str(p/'output'),'--chdir',str(p/'frozen/isolation/m3'),'/usr/bin/env','-i','PATH=/usr/bin:/bin','HOME=/tmp','GOMAXPROCS=1','CGO_ENABLED=0','GOTOOLCHAIN=local','GOPROXY=off','GOSUMDB=off','GOCACHE='+str(p/'cache'),'GOTMPDIR='+str(p/'tmp'),'/usr/bin/go','test','-p','1','-count=1','-timeout=90s','-json','./rpcservice','./rpcplatform','./cmd/rpc-native-init']
(p/'TEST-COMMAND.json').write_text(json.dumps(cmd)+'\n');start=time.monotonic()
with (p/'TEST.jsonl').open('x') as log:r=subprocess.run(cmd,stdout=log,stderr=log,timeout=120)

if r.returncode == 0:
 build=cmd[:cmd.index('/usr/bin/go')+1]+['build','-trimpath','-ldflags=-buildid=','-o',str(p/'output/rpc-native-init'),'./cmd/rpc-native-init']
 (p/'BUILD-COMMAND.json').write_text(json.dumps(build)+'\n')
 with (p/'BUILD.log').open('x') as log:r=subprocess.run(build,stdout=log,stderr=log,timeout=120-(time.monotonic()-start))
 if r.returncode==0:
  b=(p/'output/rpc-native-init').read_bytes();(p/'BUILD.json').write_text(json.dumps({'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'elf64':b[:7]==bytes([127,69,76,70,2,1,1]),'executed':False})+'\n')
verify();events=[]
for line in (p/'TEST.jsonl').read_text().splitlines():
 try:events.append(json.loads(line))
 except:pass
result={'exit':r.returncode,'elapsed':time.monotonic()-start,'pass':sum(x.get('Action')=='pass' and 'Test' in x for x in events),'fail':sum(x.get('Action')=='fail' for x in events),'sourcePins':len(pins),'pinsUnchanged':True,'nativeRuntimeQualified':False,'appDeployed':False}
(p/'RESULT.json').write_text(json.dumps(result)+'\n');print(json.dumps(result));assert r.returncode==0

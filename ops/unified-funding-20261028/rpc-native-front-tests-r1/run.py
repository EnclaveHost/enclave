from pathlib import Path
import json,hashlib,subprocess,time
p=Path(__file__).resolve().parent;s=p.parent.parent/'source';pins=json.loads((p/'PINS.json').read_text())
def verify():
 for n,h in pins.items():
  assert hashlib.sha256((p/'frozen'/n).read_bytes()).hexdigest()==h,n
  assert hashlib.sha256((s/n).read_bytes()).hexdigest()==h,n
verify()
with (p/'ATTEMPT.json').open('x') as f:json.dump({'once':True,'at':time.time()},f)
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and a['unreadUnits']==0 and a['availableMiB']-a['pendingMiB']-640>=max(27648,a['floorMiB'])
(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
base=['/usr/bin/bwrap','--die-with-parent','--unshare-user','--unshare-net','--ro-bind','/','/','--dev','/dev','--proc','/proc','--tmpfs','/tmp','--bind',str(p/'cache'),str(p/'cache'),'--bind',str(p/'tmp'),str(p/'tmp'),'--bind',str(p/'output'),str(p/'output'),'--chdir',str(p/'frozen/isolation/m2'),'/usr/bin/env','-i','PATH=/usr/bin:/bin','HOME=/tmp','GOMAXPROCS=1','CGO_ENABLED=0','GOTOOLCHAIN=local','GOPROXY=off','GOSUMDB=off','GOMODCACHE=/home/steven/go/pkg/mod','GOCACHE='+str(p/'cache'),'GOTMPDIR='+str(p/'tmp'),'/usr/bin/go']
start=time.monotonic();rows=[]
for label,tags in [('ordinary',''),('desktop','native_desktop'),('rpc','native_rpc'),('rpc-direct','native_rpc,bootstrapdirect')]:
 cmd=base+['test','-p','1','-count=1','-timeout=30s','-json','-run','^(TestRPCFront|TestDesktopFront|TestLoadedAppID)']+(['-tags',tags] if tags else [])+['./front']
 (p/(label+'-COMMAND.json')).write_text(json.dumps(cmd)+'\n')
 with (p/(label+'.jsonl')).open('x') as log:r=subprocess.run(cmd,stdout=log,stderr=log,timeout=120-(time.monotonic()-start))
 rows.append({'build':label,'exit':r.returncode});assert r.returncode==0,label
cmd=base+['test','-p','1','-run','^$','-tags','native_rpc,native_desktop','./front']
with (p/'mixed.log').open('x') as log:r=subprocess.run(cmd,stdout=log,stderr=log,timeout=120-(time.monotonic()-start))
assert r.returncode!=0 and 'nativeRPCAndDesktopBuildsCannotBeCombined' in (p/'mixed.log').read_text()
verify();result={'builds':rows,'mixedRefused':True,'elapsed':time.monotonic()-start,'sourcePins':len(pins),'pinsUnchanged':True,'deployed':False}
(p/'RESULT.json').write_text(json.dumps(result)+'\n');print(json.dumps(result))

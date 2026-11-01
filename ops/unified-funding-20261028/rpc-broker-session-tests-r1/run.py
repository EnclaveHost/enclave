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
cache=p.parent/'rpc-monitor-load-tests-r2/cache'
def base(module):
 return ['/usr/bin/bwrap','--die-with-parent','--unshare-user','--uid','0','--gid','0','--unshare-net','--ro-bind','/','/','--dev','/dev','--proc','/proc','--tmpfs','/tmp','--bind',str(cache),str(cache),'--bind',str(p/'output'),str(p/'output'),'--chdir',str(p/'frozen/isolation'/module),'/usr/bin/env','-i','PATH=/usr/bin:/bin','HOME=/tmp','GOMAXPROCS=1','CGO_ENABLED=0','GOTOOLCHAIN=local','GOPROXY=off','GOSUMDB=off','GOMODCACHE=/home/steven/go/pkg/mod','GOCACHE='+str(cache),'GOTMPDIR=/tmp','RPC_TEST_PERSISTENT_DIR='+str(p/'output'),'/usr/bin/go']
start=time.monotonic();rows=[]
commands=[('broker','m3',['test','-p','1','-count=1','-timeout=20s','-json','-run','^TestBroker(OwnerHelper|BindsActualPeerAndTransferredOwner|RejectsIdentityAndPacketSubstitution|LossAndOriginalDeadlineCloseGate)$','./rpcstorage'])]
for label,module,args in commands:
 cmd=base(module)+args
 (p/(label+'-COMMAND.json')).write_text(json.dumps(cmd)+'\n')
 with (p/(label+'.jsonl')).open('x') as log:r=subprocess.run(cmd,stdout=log,stderr=log,timeout=120-(time.monotonic()-start))
 rows.append({'phase':label,'exit':r.returncode});assert r.returncode==0,label
verify();artifacts={x.name:{'bytes':x.stat().st_size,'sha256':hashlib.sha256(x.read_bytes()).hexdigest()} for x in (p/'output').iterdir() if x.is_file()}
result={'phases':rows,'elapsed':time.monotonic()-start,'sourcePins':len(pins),'pinsUnchanged':True,'artifacts':artifacts,'deployed':False}
(p/'RESULT.json').write_text(json.dumps(result)+'\n');print(json.dumps(result))

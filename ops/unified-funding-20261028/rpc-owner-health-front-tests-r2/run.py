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
base=['/usr/bin/bwrap','--die-with-parent','--unshare-user','--uid','0','--gid','0','--unshare-net','--cap-add','CAP_NET_ADMIN','--ro-bind','/','/','--dev','/dev','--proc','/proc','--tmpfs','/tmp','--bind',str(p/'cache'),str(p/'cache'),'--bind',str(p/'tmp'),str(p/'tmp'),'--bind',str(p/'output'),str(p/'output'),'--chdir',str(p/'frozen/isolation/m2'),'/usr/bin/env','-i','PATH=/usr/bin:/bin','HOME=/tmp','GOMAXPROCS=1','CGO_ENABLED=0','GOTOOLCHAIN=local','GOPROXY=off','GOSUMDB=off','GOMODCACHE=/home/steven/go/pkg/mod','GOCACHE='+str(p/'cache'),'GOTMPDIR=/tmp','/bin/sh','-c','/usr/sbin/ip link set lo up && exec /usr/bin/go "$@"','rpc-test']
start=time.monotonic();rows=[]
for label,tags,pattern in [
 ('shield','bootstrapdirect,shielddirect','^(TestShield|TestRPCOwner)'),
 ('rpc','native_rpc,bootstrapdirect,shielddirect','^(TestRPC|TestShield|TestReady)')]:
 cmd=base+['test','-p','1','-count=1','-timeout=30s','-json','-run',pattern]+(['-tags',tags] if tags else [])+['./front']
 (p/(label+'-COMMAND.json')).write_text(json.dumps(cmd)+'\n')
 with (p/(label+'.jsonl')).open('x') as log:r=subprocess.run(cmd,stdout=log,stderr=log,timeout=120-(time.monotonic()-start))
 rows.append({'build':label,'exit':r.returncode});assert r.returncode==0,label
refused=[]
for label,tags,marker in [
 ('rpc-legacy','native_rpc','nativeRPCRequiresOwnerDirectShieldBuild'),
 ('rpc-snp-direct','native_rpc,bootstrapdirect','nativeRPCRequiresOwnerDirectShieldBuild'),
 ('rpc-shield-without-direct','native_rpc,shielddirect','nativeRPCRequiresOwnerDirectShieldBuild'),
 ('rpc-lab','native_rpc,bootstrapdirect,shielddirect,releaselab','nativeRPCRequiresOwnerDirectShieldBuild'),
 ('rpc-desktop','native_rpc,native_desktop,bootstrapdirect,shielddirect','nativeRPCAndDesktopBuildsCannotBeCombined')]:
 cmd=base+['test','-p','1','-run','^$','-tags',tags,'./front']
 (p/(label+'-COMMAND.json')).write_text(json.dumps(cmd)+'\n')
 with (p/(label+'.log')).open('x') as log:r=subprocess.run(cmd,stdout=log,stderr=log,timeout=120-(time.monotonic()-start))
 assert r.returncode!=0 and marker in (p/(label+'.log')).read_text(),label
 refused.append(label)
verify();result={'builds':rows,'invalidBuildsRefused':refused,'elapsed':time.monotonic()-start,'sourcePins':len(pins),'pinsUnchanged':True,'deployed':False}
(p/'RESULT.json').write_text(json.dumps(result)+'\n');print(json.dumps(result))

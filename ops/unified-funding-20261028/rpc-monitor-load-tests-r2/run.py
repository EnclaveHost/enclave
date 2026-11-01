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
def base(module):
 return ['/usr/bin/bwrap','--die-with-parent','--unshare-user','--uid','0','--gid','0','--unshare-net','--cap-add','CAP_NET_ADMIN','--cap-add','CAP_SYS_ADMIN','--cap-add','CAP_SYS_CHROOT','--ro-bind','/','/','--dev','/dev','--proc','/proc','--tmpfs','/tmp','--bind',str(p/'cache'),str(p/'cache'),'--bind',str(p/'output'),str(p/'output'),'--chdir',str(p/'frozen/isolation'/module),'/usr/bin/env','-i','PATH=/usr/bin:/bin','HOME=/tmp','GOMAXPROCS=1','CGO_ENABLED=0','GOTOOLCHAIN=local','GOPROXY=off','GOSUMDB=off','GOMODCACHE=/home/steven/go/pkg/mod','GOCACHE='+str(p/'cache'),'GOTMPDIR=/tmp','/bin/sh','-c','/usr/sbin/ip link set lo up && exec /usr/bin/go "$@"','rpc-test']
start=time.monotonic();rows=[]
commands=[('legacy-modes','m3',['test','-p','1','-count=1','-timeout=15s','-json','-run','^(TestDomainConfigFile|TestStageEncVolumes|TestModelVolumesMountOnlyThePinnedDisk)$','./monitor']),('legacy-ownership','m3',['test','-p','1','-count=1','-timeout=15s','-json','-run','^TestASecretDomainsEtcUnderRoot$','./monitor']),('storage','m3',['test','-p','1','-count=1','-timeout=15s','-json','./rpcstorage']),('rpc','m3',['test','-p','1','-count=1','-timeout=30s','-json','-tags','native_rpc','-run','^TestRPC','./monitor']),('rpc-build','m3',['build','-p','1','-trimpath','-tags','native_rpc','-o',str(p/'output/monitor-rpc'),'./monitor']),('ordinary-build','m3',['build','-p','1','-trimpath','-o',str(p/'output/monitor-ordinary'),'./monitor']),('desktop-build','m3',['build','-p','1','-trimpath','-tags','native_desktop','-o',str(p/'output/monitor-desktop'),'./monitor'])]
for label,module,args in commands:
 cmd=base(module)+args
 if label.startswith('legacy-'):
  cmd=[x.replace('/usr/sbin/ip link set lo up && exec', 'umask 022; /usr/sbin/ip link set lo up && exec') for x in cmd]
 if label=='legacy-ownership':
  cmd.remove('--unshare-user')
  cmd=cmd[:1]+['--cap-add','CAP_CHOWN']+cmd[1:]
  cmd=['/usr/bin/unshare','--user','--map-root-user','--map-auto','--']+cmd
 (p/(label+'-COMMAND.json')).write_text(json.dumps(cmd)+'\n')
 with (p/(label+'.jsonl')).open('x') as log:r=subprocess.run(cmd,stdout=log,stderr=log,timeout=120-(time.monotonic()-start))
 rows.append({'phase':label,'exit':r.returncode});assert r.returncode==0,label
cmd=base('m3')+['build','-p','1','-tags','native_rpc native_desktop','-o',str(p/'output/forbidden'),'./monitor']
(p/'mixed-COMMAND.json').write_text(json.dumps(cmd)+'\n')
r=subprocess.run(cmd,capture_output=True,text=True,timeout=120-(time.monotonic()-start))
(p/'mixed.txt').write_text(r.stdout+r.stderr)
assert r.returncode!=0 and 'nativeRPCAndDesktopMustNotShareAMeasuredMonitor' in r.stderr and not (p/'output/forbidden').exists()
rows.append({'phase':'mixed-build','refused':True})
verify();artifacts={x.name:{'bytes':x.stat().st_size,'sha256':hashlib.sha256(x.read_bytes()).hexdigest()} for x in (p/'output').iterdir()}
result={'phases':rows,'elapsed':time.monotonic()-start,'sourcePins':len(pins),'pinsUnchanged':True,'artifacts':artifacts,'deployed':False}
(p/'RESULT.json').write_text(json.dumps(result)+'\n');print(json.dumps(result))

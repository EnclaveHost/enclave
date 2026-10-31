from pathlib import Path
import json,hashlib,subprocess,os,time,datetime
from capture_local import capture
p=Path(__file__).resolve().parent
s=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source')
assert os.sched_getaffinity(0)=={1}
for n,h in json.loads((p/'PINS.json').read_text()).items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h
stage=json.loads((p.parent/'rpc-clock-controller-target-stage-r1/verify-RESULT.json').read_text());assert stage['success']
ad=json.loads((p.parent/'rpc-clock-target-admission-r4/storage-RESULT.json').read_text());assert ad['rc']==0 and ad['failure'] is None and time.time()-ad['at']<300
o=ad['observation'];assert o['before']==o['after'] and o['nodeExit']==0 and o['manager']['completeTransport'] and not o['manager']['errors'] and len(o['physicalAfter']['vms'])==4
assert not o['priorClockWrapperMatches'] and not o['clockStage']['contractExists'] and not o['clockStage']['intentExists']
prior=json.loads((p.parent/'rpc-clock-target-admission-r1/storage-RESULT.json').read_text())['observation'];assert o['before']==prior['before'] and o['bootNative']==prior['bootNative']
rows=o['before']['value'];assert len(rows)==4 and {v['port'] for v in rows}=={8091,8095,8097,9600}
native=o['nativeManagers'];assert len(native)==4 and not o['priorNativeControllerMatches']
by_pid={v['pid']:v for v in rows};assert len(by_pid)==4 and {v['pid']for v in native}==set(by_pid)
for v in native:
 assert v['alive'] and v['image']==by_pid[v['pid']]['exe'] and isinstance(v['creationFileTime'],str) and v['creationFileTime'].isdigit() and len(v['creationFileTime'])==18
# Native FILETIME remains an exact decimal string; CIM timestamps are not identity inputs.
handoff=json.loads((p.parent/'rpc-target-transition-package-r2/bundle/handoff.json').read_text())
for issuer in handoff['issuers']:
 assert next(v['creationFileTime'] for v in native if v['pid']==issuer['pid'])==str(issuer['created'])
identities=','.join(str(v['pid'])+':'+v['creationFileTime'] for v in native)

r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(s.parent/'unified-funding-20261028/rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-384>=max(27648,a['floorMiB'])
(p/'LOCAL-ADMISSION.json').write_text(json.dumps(a)+'\n')
spec=json.loads((p/'SPEC.json').read_text());root=spec['root'].replace('/','\\')
args=[root+'\\clock-controller.exe','--target',root,spec['nonce'],o['bootNative'],spec['samplerSha256'],spec['controllerSha256'],identities]
assert all(not any(c in x for c in [' ','"',"'",'&',';','|','<','>','\n','\r']) for x in args)
command=' '.join(args)
with(p/'INTENT.json').open('x')as f:json.dump({'at':time.time(),'command':command,'readOnlySampler':True,'noRetry':True},f);f.flush();os.fsync(f.fileno())
r=capture(['/usr/bin/ssh','-T','-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oConnectTimeout=5','-oControlMaster=no','-oControlPath=none','minipc',command],12,limit=16384)
(p/'stdout').write_text(r.pop('stdout'));(p/'stderr').write_text(r.pop('stderr'));r['success']=False
if r['rc']==0 and r['reason'] is None:
 try:
  v=json.loads((p/'stdout').read_text().lstrip('\ufeff'));r['observation']=v
  assert v['passed'] and not v['hostedCi'] and v['samplerExactDeath'] and v['samplerExit']==0 and v['managersUnchanged'] and not v['productionClockAssigned'] and not v['vmChanged'] and not v['systemContextQualified']
  assert v['sourceSha256']==spec['samplerSha256'] and v['boot']==spec['expectedBoot'] and v['deadline']==v['origin']+5000 and v['before']<=v['sample']['monotonicMilliseconds']<=v['after']<v['deadline']
  env=v['supervisorEnvelope'];assert env['MembershipVerified'] and env['LimitsVerified'] and env['JobCommitLimitBytes']==134217728 and env['BootstrapPrivateBytes']<=67108864 and env['ProcessId']==v['supervisorPid'] and env['CreationFileTime']==v['supervisorCreation']
  r['success']=True
 except Exception:r['reason']='invalid-receipt'
(p/'RESULT.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'rc':r['rc'],'reason':r['reason'],'success':r['success']}));raise SystemExit(0 if r['success'] else 1)

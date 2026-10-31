from pathlib import Path
import json,hashlib,subprocess,os,time,sys
p=Path(__file__).resolve().parent;s=p.parent.parent/'source';private=p/'private'
assert os.sched_getaffinity(0)=={1}
for n,h in json.loads((p/'PINS.json').read_text()).items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h,n
sys.path.insert(0,str(p/'frozen/rpc'))
import sample_windows_clock as sampler
import windows_files as files
c=files.c
spec=json.loads((p/'SPEC.json').read_text())
stage=json.loads((p.parent/'rpc-files-target-stage-r1/verify-RESULT.json').read_text());assert stage['success']
ad=json.loads((p.parent/'rpc-files-target-admission-r1/storage-RESULT.json').read_text());assert ad['rc']==0 and ad['failure'] is None and time.time()-ad['at']<300
o=ad['observation'];assert o['before']==o['after'] and o['nodeExit']==0 and o['manager']['completeTransport'] and not o['manager']['errors'] and o['bootNative']==spec['boot']
assert o['physicalAfter']['freeBytes']>=62709039104 and len(o['physicalAfter']['vms'])==4
expected={41272:'134375630850989593',40360:'134375630828500376',41308:'134375617394407059',38076:'134375086385617521'}
assert {r['pid']:r['creationFileTime']for r in o['nativeManagers']}==expected
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-384>=max(27648,a['floorMiB'])
(p/'LOCAL-ADMISSION.json').write_text(json.dumps(a)+'\n')
known=c.write_new(private/'known-host', (p/'KNOWN-HOST.txt').read_bytes())
observation=c.write_new(private/'observation.json',c.encode(ad));assert len(c.read_pinned(observation))<=32768
transport={'target':{'host':'192.168.8.238','port':22,'user':'claude','identityFile':'/home/steven/.ssh/minipc'},'knownHosts':known,'hostAlias':'192.168.8.148','sshSha256':hashlib.sha256(Path('/usr/bin/ssh').read_bytes()).hexdigest(),'samplerPath':spec['samplerPath'],'samplerSha256':spec['samplerSha256']}
# This new attempt is exclusively inert qualification. It cannot adopt the
# production credential instance or original VM attempt.
started=time.monotonic();c.write_new(p/'INTENT.json',c.encode({'nonproduction':True,'noRetry':True,'specSha256':hashlib.sha256((p/'SPEC.json').read_bytes()).hexdigest()}))
begin=c.begin(private,spec['attempt'],'rpc-owned-'+spec['attempt'],spec['vmAttempt'])
clock=sampler.sample(dict(begin=begin,windowsBoot=spec['boot'],**transport))
clockrow=c.validate(clock)
config=dict(clock=clock,transport=transport,helper=spec['helper'],nonce=spec['nonce'],phase='cut-seed',files={'observation.json':observation})
result=files.stage_inputs(config);row=c.protocol.decode(c.read_pinned(result));native=c.protocol.decode(c.read_pinned(row['response']))
assert row['rpcReady'] is False and row['remoteDeathProven'] is False and row['reservationMayRelease'] is False
receipt={'passed':True,'elapsedSeconds':time.monotonic()-started,'actualPinnedSsh':True,'actualBeginSampleFinish':True,'nonproductionAttempt':spec['attempt'],'nonproductionVmAttempt':spec['vmAttempt'],'clock':clockrow,'stage':row['result'],'helper':{'pid':native['pid'],'creation':native['creation'],'origin':native['origin'],'deadline':native['deadline'],'envelope':native['envelope']},'responseSha256':row['response']['sha256'],'helperImage':spec['helper'],'vmChanged':False,'productionClockAssigned':False,'rpcReady':False,'remoteDeathProven':False,'reservationMayRelease':False}
(p/'RESULT.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps({'passed':True,'helperPid':native['pid'],'seconds':receipt['elapsedSeconds']}))

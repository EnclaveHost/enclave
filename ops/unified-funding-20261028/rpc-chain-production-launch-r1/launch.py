# Fixed operator recipe for the distinct successor RPC attempt. Never replays the original cut or launch.
from pathlib import Path
import hashlib,importlib.util,json,os,stat,subprocess,time
os.umask(0o077)
p=Path(__file__).resolve().parent
spec=json.loads((p/'SPEC.json').read_text())
pins=json.loads((p/'PINS.json').read_text())
for name,expected in pins.items():
 with Path(name).open('rb') as f:assert hashlib.file_digest(f,'sha256').hexdigest()==expected,name
s=Path(spec['sourceRoot'])
def load(name):
 definition=importlib.util.spec_from_file_location(name,s/'rpc'/(name+'.py'));module=importlib.util.module_from_spec(definition);definition.loader.exec_module(module);return module
r=load('run_startup');sample=load('sample_windows_clock');c=r.c
unit='enclave-rpc-launch-'+spec['attempt']+'.service'
row=r.show(unit)
expected={'Id':unit,'MainPID':str(os.getpid()),'InvocationID':os.environ.get('INVOCATION_ID',''),'ActiveState':'active','Type':'exec','MemoryMax':str(128<<20),'MemorySwapMax':'0','CPUQuotaPerSecUSec':'1s','TasksMax':'16','RuntimeMaxUSec':'2min','TimeoutStopUSec':'1s','KillMode':'control-group','Restart':'no','SendSIGKILL':'yes','FinalKillSignal':'9','NoNewPrivileges':'yes','LimitCORE':'0'}
assert expected['InvocationID'] and all(row[k]==v for k,v in expected.items())
assert Path('/proc/self/cgroup').read_text().strip()=='0::'+row['ControlGroup']
assert Path('/proc/sys/kernel/random/boot_id').read_text().strip()==spec['ownerBootId']
config=c.protocol.decode(c.read_pinned(spec['template']))
assert set(config)=={'windows','retainedCut','media','network','nonces','export','localGuestOwner','ownerReserveMiB'}
observed=c.read(spec['observationPath']);host=c.protocol.decode(observed)
assert host['rc']==0 and host['failure'] is None and host['readOnly'] is True
obs=host['observation'];assert obs['success'] and obs['before']==obs['after'] and obs['nodeExit']==0 and obs['manager']['completeTransport'] and not obs['manager']['errors']
assert 0<=time.time()-host['at']<45 and obs['bootNative']==spec['windowsBoot']
for label in ('physicalBefore','physicalAfter'):
 assert obs[label]['physicalBytes']==120070115328 and obs[label]['freeBytes']>=spec['windowsRequiredFreeBytes']
 assert obs[label]['diskFreeBytes']>=21743271936
 expectedVms={'28ca7b93-350b-4385-844e-89c8100fbdf9':2732589056,'1ca457d6-17bf-47fa-ad26-72770d74e08b':536870912,'dd8df95d-b771-4545-a861-0092e74a40f3':8589934592,'4a4ddcac-d06f-4a5c-b96e-e692302db5c8':4294967296}
 assert {x['Id']:x['MemoryAssigned'] for x in obs[label]['vms']}==expectedVms and all(x['State']==2 for x in obs[label]['vms'])
expectedManagers={41272:'134375630850989593',40360:'134375630828500376',41308:'134375617394407059',38076:'134375086385617521'}
assert {x['pid']:x['creationFileTime'] for x in obs['nativeManagers']}==expectedManagers and all(x['alive'] for x in obs['nativeManagers'])
# Static custody/tool/source/resource checks precede the consumed original clock.
# They neither submit native work nor create a production export.
r.resource_admission(config)
for name,sha in config['export']['runtimePins'].items():assert r.prepare.digest(name)==sha
credentials=c.protocol.decode(c.read_pinned(config['export']['credentialReceipt']))
assert credentials['attempt']==spec['attempt'] and credentials['instance']==spec['instance']
for role,value in config['export']['roles'].items():
 c.directory(value['parent']);assert not (Path(value['parent'])/(spec['attempt']+'-'+role)).exists()
 for name,metadata in value['originals']:r.prepare.volume.directory(Path(name).parent);assert r.prepare.volume.metadata(name)==metadata
 for kind,key in [('server','tls'),('client','clientTls')]:r.prepare.tls_directory(value[key],role,kind,credentials['roles'][role])
assert not (Path(config['export']['stateParent'])/spec['attempt']).exists() and not Path(config['export']['output']).exists()
assert c.read(spec['observationPath'])==observed
prior=c.inspect_historical(config['retainedCut']['clock'])
assert prior['attempt']=='8ee4452b174746c2b606b9b68f0fa623' and prior['vmAttempt']=='7647ee54e3c24997bb8ab5da70427109'
assert prior['bootId']==spec['ownerBootId'] and prior['windowsBoot']==spec['windowsBoot']
assert time.monotonic_ns()>prior['deadlineMonotonicNs'] and time.time_ns()>prior['deadlineUtcNs']
assert len(config['retainedCut']['successors'])==1
prior_successor=c.inspect_historical(config['retainedCut']['successors'][0])
assert prior_successor['attempt']=='25eecdee9cff4836ae68445d206bec8f' and prior_successor['vmAttempt']=='5a343f975e2e483ab4d479c912bc5c0c'
assert prior_successor['bootId']==spec['ownerBootId'] and prior_successor['windowsBoot']==spec['windowsBoot']
assert time.monotonic_ns()>prior_successor['deadlineMonotonicNs'] and time.time_ns()>prior_successor['deadlineUtcNs']
# No fresh origin is possible after this exclusive create, even on lost reply.
begin=c.begin(spec['clockParent'],spec['attempt'],spec['instance'],spec['vmAttempt'])
clock=sample.sample(dict(config['windows']['transport'],begin=begin,windowsBoot=spec['windowsBoot']))
root=Path(clock['path']).parent
config['clock']=clock
config['observation']=c.write_new(root/'observation.json',observed)
r.preflight(config)
request=c.write_new(root/'startup-request.json',c.encode(config))
owner='enclave-rpc-startup-'+spec['attempt']+'.service'
props=['Type=exec','MemoryMax=256M','MemorySwapMax=0','CPUQuota=100%','TasksMax=16','RuntimeMaxSec=600','TimeoutStopSec=1','KillMode=control-group','Restart=no','SendSIGKILL=yes','FinalKillSignal=SIGKILL','NoNewPrivileges=yes','LimitCORE=0','UMask=0077']
c.write_new(root/'owner-submit.intent',c.encode({'unit':owner,'request':request,'noRetry':True}))
try:
 c.validate(clock)
 subprocess.run(['/usr/bin/systemd-run','--user','--quiet','--unit='+owner,*['--property='+x for x in props],'/usr/bin/python3','-B',str(s/'rpc/run_startup.py'),request['path']],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5,check=True)
 c.write_new(root/'owner-submit.receipt',c.encode({'unit':owner,'acknowledged':True,'rpcReady':False,'remoteDeathProven':False,'reservationMayRelease':False}))
except BaseException:
 c.write_new(root/'owner-submit.held',c.encode({'unit':owner,'unknown':True,'automaticRetry':False,'reservationMayRelease':False}));raise

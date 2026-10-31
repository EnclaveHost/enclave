#!/usr/bin/env python3
"""One-shot owner runtime request installation/submission over pinned SSH.

Uses the already seeded, pinned runtime helper. The fixed bootstrap verifies its
import closure and exact independent unit before reading stdin. No guest image
change, fallback authority, automatic adoption, or retry is introduced.
"""
import base64,hashlib,importlib.util,json,os,re,shlex,time
from pathlib import Path
s=importlib.util.spec_from_file_location('activation_delivery',Path(__file__).with_name('deliver_activation.py'))
d=importlib.util.module_from_spec(s);s.loader.exec_module(d)
p=d.p;owner=d.owner
IMPORTS={n:(0o644 if n=='storage_protocol.py' else 0o755)for n in ('start_runtime.py','activate_storage.py','attach_storage.py','identity.py','storage_protocol.py')}

# Transported owner code, not downloaded code or a guest-installed replacement.
# Keep it self-contained so tests execute these exact bytes in a private namespace.
BOOTSTRAP=r'''
import base64,hashlib,json,os,re,stat,sys,time,types
from pathlib import Path
os.umask(0o077)
phase,boot,wanted,deadline,pin64=sys.argv[1:]
if os.geteuid()!=0 or phase not in ('l1','base') or not re.fullmatch('[0-9a-f]{64}',wanted):raise ValueError('Exact root runtime phase required')
if Path('/proc/sys/kernel/random/boot_id').read_text().strip()!=boot:raise ValueError('Guest boot changed')
if not re.fullmatch('[0-9]{1,20}',deadline):raise ValueError('Integral original deadline required')
deadline=int(deadline)
def current():
 if not time.time_ns()<deadline<=time.time_ns()+900_000_000_000:raise ValueError('Original runtime window expired')
def directory(path):
 if path.resolve(strict=True)!=path:raise ValueError('Canonical namespace required')
 for parent in [path,*path.parents]:
  st=parent.lstat()
  if not stat.S_ISDIR(st.st_mode) or st.st_uid!=0 or st.st_mode&0o022:raise ValueError('Root namespace required')
root=Path('/opt/enclave-rpc');directory(root)
pins=json.loads(base64.b64decode(pin64,validate=True));names={'start_runtime.py':0o755,'activate_storage.py':0o755,'attach_storage.py':0o755,'identity.py':0o755,'storage_protocol.py':0o644}
if set(pins)!=set(names):raise ValueError('Complete import closure required')
source=None
for name,mode in names.items():
 path=root/name;fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb')as f:
  st=os.fstat(f.fileno())
  if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_nlink!=1 or stat.S_IMODE(st.st_mode)!=mode or st.st_size>262144:raise ValueError('Root module custody differs')
  raw=f.read(262145)
 if len(raw)>262144 or hashlib.sha256(raw).hexdigest()!=pins[name]:raise ValueError('Seeded import source differs')
 if name=='start_runtime.py':source=raw
current()
runtime=types.ModuleType('pinned_runtime');runtime.__file__=str(root/'start_runtime.py')
exec(compile(source,runtime.__file__,'exec'),runtime.__dict__)
runtime.envelope(phase)
raw=sys.stdin.buffer.read(65537)
if len(raw)>65536 or hashlib.sha256(raw).hexdigest()!=wanted or json.loads(raw)['phase']!=phase:raise ValueError('Runtime request bytes differ')
current();config=Path('/etc/enclave-rpc');directory(config)
path=config/('runtime-start-'+phase+'.json')
fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
with os.fdopen(fd,'wb')as f:f.write(raw);f.flush();os.fsync(f.fileno())
fd=os.open(config,os.O_RDONLY|os.O_DIRECTORY)
try:os.fsync(fd)
finally:os.close(fd)
current();result=runtime.execute(phase,raw);current()
print(json.dumps({'schema':'owned-rpc-runtime-delivery-receipt/1','requestSha256':wanted,'unitInvocation':os.environ['INVOCATION_ID'],'result':result}),flush=True)
'''


def package(config,now):
 _,c,hostkey=d.package(config['attachmentReceipt'],config['seedReceipt'],config['guestBootId'],now)
 raw=owner.read_pinned(config['runtimeReceipt']);result=p.decode(raw);seed=p.decode(owner.read_pinned(config['seedReceipt']))
 expected={'schema','phase','attempt','bootId','instance','deadlineUtcNs','requestSha256','inputHashes','clientsStarted','rpcReady','adopted','writersFenced'}
 if set(result)!=expected or result['schema']!='owned-rpc-runtime-request/1' or result['phase'] not in ('l1','base'):
  raise ValueError('Exact prepared runtime receipt required')
 for k in ('attempt','bootId','instance','deadlineUtcNs'):
  if result[k]!=c[k] or type(result[k])is not type(c[k]):raise ValueError('Runtime receipt belongs to another attempt/window')
 if any(result[k]is not False for k in ('clientsStarted','rpcReady','adopted','writersFenced')):raise ValueError('Premature runtime claim')
 if set(result['inputHashes'])!={'activationRequest','activationReady','attachmentReceipt','imageReceipt','seedReceipt'}:raise ValueError('Runtime provenance incomplete')
 for value in result['inputHashes'].values():p.digest(value)
 for key in ('attachmentReceipt','seedReceipt'):
  if result['inputHashes'][key]!=config[key]['sha256']:raise ValueError('Runtime artifact lineage differs')
 request_raw=owner.read_pinned({'path':str(Path(config['runtimeReceipt']['path']).parent/('runtime-start-'+result['phase']+'.json')),'sha256':result['requestSha256']})
 request=p.decode(request_raw)
 if set(request)!={'phase','activationRequestSha256','activationReadySha256','runtimePins'} or request['phase']!=result['phase']:
  raise ValueError('Exact runtime request required')
 for key in ('activationRequest','activationReady'):
  if request[key+'Sha256']!=result['inputHashes'][key]:raise ValueError('Runtime activation lineage differs')
 pins={}
 for name,mode in IMPORTS.items():
  row=seed['records']['/opt/enclave-rpc/'+name];p.digest(row['sha256'])
  if row['mode']!=format(mode,'04o') or row.get('private'):raise ValueError('Seeded bootstrap closure differs')
  pins[name]=row['sha256']
 if request['runtimePins'].get('/opt/enclave-rpc/start_runtime.py')!=pins['start_runtime.py']:raise ValueError('Runtime helper is not the seeded helper')
 return request_raw,result,c,hostkey,pins


def remote_command(result,pins):
 phase=result['phase']
 if phase not in ('l1','base'):raise ValueError('Exact phase required')
 props=['Type=exec','MemoryMax=64M','MemorySwapMax=0','CPUQuota=100%','TasksMax=8','LimitCORE=0','RuntimeMaxSec=20',
        'TimeoutStopSec=1','KillMode=control-group','SendSIGKILL=yes','FinalKillSignal=SIGKILL','Restart=no','UMask=0077']
 # No PrivateTmp/ProtectSystem/etc: mount submission needs PID1's mount namespace.
 return ['/usr/bin/sudo','-n','/usr/bin/systemd-run','--quiet','--wait','--pipe','--unit=enclave-rpc-runtime-'+phase+'.service',
         *['--property='+v for v in props],'/usr/bin/python3','-I','-c',BOOTSTRAP,phase,result['bootId'],result['requestSha256'],
         str(result['deadlineUtcNs']),base64.b64encode(json.dumps(pins,sort_keys=True).encode()).decode()]


def validate_receipt(receipt,result,c,started,now):
 if set(receipt)!={'schema','requestSha256','unitInvocation','result'} or receipt['schema']!='owned-rpc-runtime-delivery-receipt/1' or receipt['requestSha256']!=result['requestSha256'] or not re.fullmatch('[0-9a-f]{32}',receipt['unitInvocation']):
  raise ValueError('Runtime delivery receipt differs')
 r=receipt['result'];keys={'phase','attempt','bootId','activationReadySha256','owner','mount','clients','atUtcNs','rpcReady','writersFenced','adopted'}
 if set(r)!=keys or any(r[k]!=result[k]for k in ('phase','attempt','bootId')) or r['activationReadySha256']!=result['inputHashes']['activationReady'] or any(r[k]is not False for k in ('rpcReady','writersFenced','adopted')):
  raise ValueError('Runtime result binding differs')
 if type(r['atUtcNs'])is not int or not started<=r['atUtcNs']<=now<c['deadlineUtcNs']:raise ValueError('Stale or late runtime receipt')
 def process(v,unit):
  if set(v)!={'unit','invocation','pid','start','cgroup'} or v['unit']!=unit or not re.fullmatch('[0-9a-f]{32}',v['invocation']) or type(v['pid'])is not int or v['pid']<=0 or not re.fullmatch('[0-9]+',v['start']) or not v['cgroup'].startswith('/'):
   raise ValueError('Exact runtime process receipt required')
 process(r['owner'],'enclave-rpc-storage-activation.service')
 sides=('el','cl')if result['phase']=='l1'else('base',)
 if set(r['clients'])!=set(sides):raise ValueError('Runtime client set differs')
 for side in sides:process(r['clients'][side],'enclave-rpc-'+side+'.service')
 mount=r['mount'];where='/srv/enclave-l1-pair'if result['phase']=='l1'else'/srv/enclave-base-holder'
 if set(mount)!={'id','device','where'} or mount['where']!=where or not re.fullmatch('[0-9]+',mount['id']) or not re.fullmatch('[0-9]+:[0-9]+',mount['device']):raise ValueError('Runtime mount receipt differs')


def send(config):
 if set(config)!={'runtimeReceipt','attachmentReceipt','seedReceipt','guestBootId','target','jump','sshSha256','journalRoot'}:raise ValueError('Exact runtime delivery configuration required')
 wall=time.time_ns();mono=time.monotonic_ns();raw,result,c,hostkey,pins=package(config,wall)
 p.digest(config['sshSha256'])
 if hashlib.sha256(Path('/usr/bin/ssh').read_bytes()).hexdigest()!=config['sshSha256']:raise ValueError('SSH client changed')
 target=d.endpoint(config['target'])
 if config['target']['user']!='rpcadmin':raise ValueError('Exact seeded login required')
 jump=config['jump'];jump_args=None;known=None
 if jump is not None:
  if set(jump)!={'endpoint','alias','knownHosts'}:raise ValueError('Explicit pinned jump required')
  jump_args=d.endpoint(jump['endpoint']);known=owner.read_pinned(jump['knownHosts'])
  if not known or len(known)>16384:raise ValueError('Bounded jump keys required')
 root=owner.directory(config['journalRoot']);journal=root/(c['attempt']+'-'+result['phase']);journal.mkdir(mode=0o700)
 def write(name,value):owner.write_new(journal/name,value if isinstance(value,bytes)else json.dumps(value,sort_keys=True).encode()+b'\n')
 def current():
  now=time.time_ns()
  if abs(now-wall-(time.monotonic_ns()-mono))>2_000_000_000:raise ValueError('Owner clock changed')
  p.validate_attachment(c,now,config['guestBootId']);return (c['deadlineUtcNs']-now)/1e9
 write('guest-known-hosts',(c['instance']+' '+hostkey+'\n').encode());argv=d.ssh_options(journal/'guest-known-hosts',c['instance'])
 if jump_args:
  write('jump-known-hosts',known);host=config['target']['host'];dest=('['+host+']'if ':'in host else host)+':'+str(config['target']['port'])
  argv+=['-oProxyCommand='+shlex.join(d.ssh_options(journal/'jump-known-hosts',jump['alias'])+['-W',dest]+jump_args)]
 argv+=target+[shlex.join(remote_command(result,pins))]
 if current()<28:raise TimeoutError('Insufficient original runtime window')
 write('intent.json',{'attempt':c['attempt'],'phase':result['phase'],'requestSha256':result['requestSha256'],'bootstrapSha256':p.sha(BOOTSTRAP.encode()),'bootId':c['bootId'],'deadlineUtcNs':c['deadlineUtcNs'],'outcome':'unresolved-until-exact-receipt'})
 for folder in (journal,root):
  fd=os.open(folder,os.O_RDONLY|os.O_DIRECTORY)
  try:os.fsync(fd)
  finally:os.close(fd)
 if package(config,time.time_ns())!=(raw,result,c,hostkey,pins):raise ValueError('Runtime inputs changed before submission')
 # Exactly one transport call. A lost result leaves local and remote attempts held.
 out=d.exchange(argv,raw,min(25,current()));receipt=p.decode(out);current();validate_receipt(receipt,result,c,wall,time.time_ns())
 write('receipt.json',receipt)
 fd=os.open(journal,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
 current();return {'receipt':receipt,'rpcReady':False,'adopted':False,'remoteDeathProven':False,'writersFenced':False}

if __name__=='__main__':
 import sys
 os.umask(0o077);print(json.dumps(send(p.decode(Path(sys.argv[1]).read_bytes()))))

#!/usr/bin/env python3
"""Observe the seeded guest before constructing its storage attachment contract.

Run on the owner host that already holds the guest SSH identity. Public receipts
must arrive through the authenticated owner workflow; hashes do not supply that
provenance. This observes a seeded instance/boot, not hardware attestation, an
exclusive VM association, storage readiness, adoption or remote process death.
"""
import base64,hashlib,importlib.util,json,os,re,shlex,time
from pathlib import Path
s=importlib.util.spec_from_file_location('guest_delivery',Path(__file__).with_name('deliver_activation.py'))
d=importlib.util.module_from_spec(s);s.loader.exec_module(d)
p=d.p;owner=d.owner
FILES={'/opt/enclave-rpc/identity.py':0o755,'/opt/enclave-rpc/manifest.json':0o644,
       '/opt/enclave-rpc/chain_service.py':0o755,'/etc/enclave-rpc/identity.json':0o644}

BOOTSTRAP=r'''
import base64,hashlib,json,os,re,stat,subprocess,sys,time,types
from pathlib import Path
attempt,instance,created,deadline,wanted,pin64=sys.argv[1:]
if os.geteuid()!=0 or not re.fullmatch('[0-9a-f]{32}',attempt) or not re.fullmatch('rpc-owned-[a-z0-9-]{8,64}',instance) or not re.fullmatch('[0-9a-f]{64}',wanted):raise ValueError('Exact root identity observation required')
if not all(re.fullmatch('[0-9]{1,19}',v)for v in (created,deadline)):raise ValueError('Integral original window required')
created=int(created);deadline=int(deadline);wall=time.time_ns();mono=time.monotonic_ns()
def current():
 now=time.time_ns()
 if deadline-created!=900_000_000_000 or not created<=now<deadline or abs(now-wall-(time.monotonic_ns()-mono))>2_000_000_000:raise ValueError('Original window expired or clock changed')
current()
unit='enclave-rpc-guest-observe-'+attempt+'.service'
keys=['Id','MainPID','InvocationID','ControlGroup','Type','RuntimeMaxUSec','TimeoutStopUSec','MemoryMax','MemorySwapMax','CPUQuotaPerSecUSec','KillMode','Restart','SendSIGKILL','FinalKillSignal','User','Group','TasksMax','NoNewPrivileges','ProtectSystem','ProtectHome','PrivateNetwork']
result=subprocess.run(['/usr/bin/systemctl','show',unit,'--property='+','.join(keys),'--no-pager'],check=True,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=2)
if len(result.stdout)>8192:raise ValueError('Bounded unit read required')
row={}
for line in result.stdout.decode().splitlines():
 key,sep,value=line.partition('=')
 if not sep or key in row:raise ValueError('Exact unit properties required')
 row[key]=value
inv=os.environ['INVOCATION_ID']
expected={'Id':unit,'MainPID':str(os.getpid()),'InvocationID':inv,'Type':'exec','RuntimeMaxUSec':'10s','TimeoutStopUSec':'1s','MemoryMax':str(64<<20),'MemorySwapMax':'0','CPUQuotaPerSecUSec':'1s','KillMode':'control-group','Restart':'no','SendSIGKILL':'yes','FinalKillSignal':'9','User':'root','Group':'root','TasksMax':'8','NoNewPrivileges':'yes','ProtectSystem':'strict','ProtectHome':'yes','PrivateNetwork':'yes'}
if not re.fullmatch('[0-9a-f]{32}',inv) or set(row)!=set(keys) or any(row[k]!=v for k,v in expected.items()) or Path('/proc/self/cgroup').read_text().strip()!='0::'+row['ControlGroup']:raise ValueError('Independent observation envelope differs')
def directory(path):
 if path.resolve(strict=True)!=path:raise ValueError('Canonical root namespace required')
 for parent in [path,*path.parents]:
  st=parent.lstat()
  if not stat.S_ISDIR(st.st_mode) or st.st_uid!=0 or st.st_mode&0o022:raise ValueError('Root namespace differs')
def read(path,mode,limit):
 directory(path.parent)
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb')as f:
  st=os.fstat(f.fileno())
  if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_nlink!=1 or stat.S_IMODE(st.st_mode)!=mode or not 0<st.st_size<=limit:raise ValueError('Root file custody differs')
  raw=f.read(limit+1);after=os.fstat(f.fileno())
  if (st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) or len(raw)!=st.st_size:raise ValueError('Root file changed during read')
 return raw
def boot_id():
 with open('/proc/sys/kernel/random/boot_id')as f:value=f.read(38).strip()
 if not re.fullmatch('[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',value):raise ValueError('Exact guest boot required')
 return value
boot=boot_id();pins=json.loads(base64.b64decode(pin64,validate=True))
instance_path=Path('/var/lib/cloud/data/instance-id')
instance_raw=read(instance_path,0o644,128)
if instance_raw.decode().strip()!=instance:raise ValueError('Actual cloud instance differs')
names={'/opt/enclave-rpc/identity.py':0o755,'/opt/enclave-rpc/manifest.json':0o644,'/opt/enclave-rpc/chain_service.py':0o755,'/etc/enclave-rpc/identity.json':0o644}
if set(pins)!=set(names):raise ValueError('Exact seeded identity closure required')
files={}
for name,mode in names.items():
 current();raw=read(Path(name),mode,262144)
 if not re.fullmatch('[0-9a-f]{64}',pins[name]) or hashlib.sha256(raw).hexdigest()!=pins[name]:raise ValueError('Seeded identity file changed')
 files[name]=raw
identity=types.ModuleType('pinned_identity');identity.__file__='/opt/enclave-rpc/identity.py'
exec(compile(files[identity.__file__],identity.__file__,'exec'),identity.__dict__)
config=json.loads(files['/etc/enclave-rpc/identity.json'])
if config.get('instance')!=instance or config.get('runtimePins')!={n:pins[n]for n in ('/opt/enclave-rpc/manifest.json','/opt/enclave-rpc/chain_service.py')}:raise ValueError('Seed identity configuration differs')
identity.check_context(config) # Read-only; never initialize accounts or engine JWT.
for name,mode in names.items():
 if read(Path(name),mode,262144)!=files[name]:raise ValueError('Seeded identity changed during observation')
if boot_id()!=boot or read(instance_path,0o644,128)!=instance_raw:raise ValueError('Guest boot or instance changed during observation')
current()
print(json.dumps({'schema':'owned-rpc-guest-observation/1','attempt':attempt,'instance':instance,'guestBootId':boot,'createdUtcNs':created,'deadlineUtcNs':deadline,'bindingSha256':wanted,'runtimePins':pins,'unitInvocation':inv,'atUtcNs':time.time_ns(),'seededInstanceObserved':True,'rpcReady':False,'storageAttached':False,'attestationVerified':False,'vmAssociationVerified':False,'writersFenced':False}),flush=True)
'''


def package(config,now):
 server_raw=owner.read_pinned(config['serverContract']);seed_raw=owner.read_pinned(config['seedReceipt'])
 server=p.decode(server_raw);seed=p.decode(seed_raw)
 p.identity(server['attempt'],server['instance']);p.boot(server['bootId'])
 p.window(server['createdUtcNs'],server['deadlineUtcNs'],now)
 clock=server['startupClock']
 if set(clock)!={'path','sha256'} or not Path(clock['path']).is_absolute():raise ValueError('Original prepared startup clock binding required')
 p.digest(clock['sha256'])
 hostkey=d.seed_host_key(seed,server['instance'],server['attempt']);pins={}
 for name,mode in FILES.items():
  row=seed['records'][name];p.digest(row['sha256'])
  if row['mode']!=format(mode,'04o') or row.get('private'):raise ValueError('Public seeded identity closure differs')
  pins[name]=row['sha256']
 binding={'serverContractSha256':p.sha(server_raw),'seedReceiptSha256':p.sha(seed_raw),'startupClockSha256':clock['sha256']}
 return server,hostkey,pins,p.sha(json.dumps(binding,sort_keys=True).encode())


def remote_command(c,pins,binding):
 props=['Type=exec','User=root','Group=root','MemoryMax=64M','MemorySwapMax=0','CPUQuota=100%','TasksMax=8','LimitCORE=0','RuntimeMaxSec=10','TimeoutStopSec=1','KillMode=control-group','SendSIGKILL=yes','FinalKillSignal=SIGKILL','Restart=no','UMask=0077','NoNewPrivileges=yes','ProtectSystem=strict','ProtectHome=yes','PrivateNetwork=yes']
 return ['/usr/bin/sudo','-n','/usr/bin/systemd-run','--quiet','--wait','--pipe','--unit=enclave-rpc-guest-observe-'+c['attempt']+'.service',*['--property='+v for v in props],'/usr/bin/python3','-I','-c',BOOTSTRAP,c['attempt'],c['instance'],str(c['createdUtcNs']),str(c['deadlineUtcNs']),binding,base64.b64encode(json.dumps(pins,sort_keys=True).encode()).decode()]


def validate_receipt(r,c,pins,binding,started,now):
 expected={'schema':'owned-rpc-guest-observation/1','attempt':c['attempt'],'instance':c['instance'],'createdUtcNs':c['createdUtcNs'],'deadlineUtcNs':c['deadlineUtcNs'],'bindingSha256':binding,'runtimePins':pins,'seededInstanceObserved':True,'rpcReady':False,'storageAttached':False,'attestationVerified':False,'vmAssociationVerified':False,'writersFenced':False}
 if set(r)!=set(expected)|{'guestBootId','unitInvocation','atUtcNs'} or any(r[k]!=v or type(r[k])is not type(v)for k,v in expected.items()):raise ValueError('Guest observation binding differs')
 p.boot(r['guestBootId'])
 if not re.fullmatch('[0-9a-f]{32}',r['unitInvocation']) or type(r['atUtcNs'])is not int or not started<=r['atUtcNs']<=now<c['deadlineUtcNs']:raise ValueError('Fresh guest observation required')


def observe(config):
 if set(config)!={'serverContract','seedReceipt','target','jump','sshSha256','journalRoot'}:raise ValueError('Exact guest observation configuration required')
 wall=time.time_ns();mono=time.monotonic_ns();c,hostkey,pins,binding=package(config,wall)
 p.digest(config['sshSha256'])
 if p.sha(Path('/usr/bin/ssh').read_bytes())!=config['sshSha256']:raise ValueError('SSH client changed')
 target=d.endpoint(config['target'])
 if config['target']['user']!='rpcadmin':raise ValueError('Exact seeded login required')
 jump=config['jump'];jump_args=None;known=None
 if jump is not None:
  if set(jump)!={'endpoint','alias','knownHosts'}:raise ValueError('Explicit pinned jump required')
  jump_args=d.endpoint(jump['endpoint']);known=owner.read_pinned(jump['knownHosts'])
  if not known or len(known)>16384:raise ValueError('Bounded jump host keys required')
 root=owner.directory(config['journalRoot']);journal=root/(c['attempt']+'-guest-observe');journal.mkdir(mode=0o700)
 def write(name,value):owner.write_new(journal/name,value if isinstance(value,bytes)else json.dumps(value,sort_keys=True).encode()+b'\n')
 def current():
  now=time.time_ns()
  if abs(now-wall-(time.monotonic_ns()-mono))>2_000_000_000:raise ValueError('Owner clock changed')
  p.window(c['createdUtcNs'],c['deadlineUtcNs'],now);return(c['deadlineUtcNs']-now)/1e9
 write('guest-known-hosts',(c['instance']+' '+hostkey+'\n').encode());argv=d.ssh_options(journal/'guest-known-hosts',c['instance'])
 if jump_args:
  write('jump-known-hosts',known);host=config['target']['host'];dest=('['+host+']'if ':'in host else host)+':'+str(config['target']['port'])
  argv+=['-oProxyCommand='+shlex.join(d.ssh_options(journal/'jump-known-hosts',jump['alias'])+['-W',dest]+jump_args)]
 argv+=target+[shlex.join(remote_command(c,pins,binding))]
 if current()<18:raise TimeoutError('Insufficient original guest observation window')
 write('intent.json',{'attempt':c['attempt'],'bindingSha256':binding,'bootstrapSha256':p.sha(BOOTSTRAP.encode()),'createdUtcNs':c['createdUtcNs'],'deadlineUtcNs':c['deadlineUtcNs'],'outcome':'unresolved-until-exact-observation'})
 for folder in(journal,root):
  fd=os.open(folder,os.O_RDONLY|os.O_DIRECTORY)
  try:os.fsync(fd)
  finally:os.close(fd)
 if package(config,time.time_ns())!=(c,hostkey,pins,binding):raise ValueError('Guest observation inputs changed')
 out=d.exchange(argv,b'',min(15,current()));r=p.decode(out);current();validate_receipt(r,c,pins,binding,wall,time.time_ns());write('receipt.json',r)
 fd=os.open(journal,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
 current()
 return {'guestBootId':r['guestBootId'],'receipt':{'path':str(journal/'receipt.json'),'sha256':p.sha((json.dumps(r,sort_keys=True)+'\n').encode())},'rpcReady':False,'storageAttached':False,'attestationVerified':False,'vmAssociationVerified':False,'remoteDeathProven':False,'writersFenced':False}


if __name__=='__main__':
 import sys
 os.umask(0o077);print(json.dumps(observe(p.decode(Path(sys.argv[1]).read_bytes()))))

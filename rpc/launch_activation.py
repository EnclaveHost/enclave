#!/usr/bin/env python3
"""Submit the delivered guest activation once; acknowledge its armed owner only.

The transported bootstrap uses existing seeded imports and a separately bounded
root unit. Lost replies consume the attempt. Storage/RPC readiness, adoption,
writer fencing and remote death are deliberately separate observations.
"""
import base64,hashlib,importlib.util,json,os,re,shlex,time
from pathlib import Path
s=importlib.util.spec_from_file_location('activation_delivery',Path(__file__).with_name('deliver_activation.py'))
d=importlib.util.module_from_spec(s);s.loader.exec_module(d)
p=d.p;owner=d.owner
IMPORTS={n:(0o644 if n=='storage_protocol.py' else 0o755)for n in ('activate_storage.py','attach_storage.py','identity.py','storage_protocol.py')}

BOOTSTRAP=r'''
import base64,hashlib,json,os,re,select,stat,sys,time,types
from pathlib import Path
os.umask(0o077)
attempt,boot,wanted,deadline,pin64=sys.argv[1:]
if os.geteuid()!=0 or not re.fullmatch('[0-9a-f]{32}',attempt) or not re.fullmatch('[0-9a-f]{64}',wanted):raise ValueError('Exact root activation attempt required')
if Path('/proc/sys/kernel/random/boot_id').read_text().strip()!=boot:raise ValueError('Guest boot changed')
if not re.fullmatch('[0-9]{1,20}',deadline):raise ValueError('Integral original deadline required')
deadline=int(deadline);wall=time.time_ns();mono=time.monotonic_ns()
def current():
 now=time.time_ns()
 if abs(now-wall-(time.monotonic_ns()-mono))>2_000_000_000 or not now<deadline<=wall+900_000_000_000:raise ValueError('Original activation window expired or clock changed')
def directory(path):
 if path.resolve(strict=True)!=path:raise ValueError('Canonical namespace required')
 for parent in [path,*path.parents]:
  st=parent.lstat()
  if not stat.S_ISDIR(st.st_mode) or st.st_uid!=0 or st.st_mode&0o022:raise ValueError('Root namespace required')
root=Path('/opt/enclave-rpc');directory(root)
pins=json.loads(base64.b64decode(pin64,validate=True));names={'activate_storage.py':0o755,'attach_storage.py':0o755,'identity.py':0o755,'storage_protocol.py':0o644}
if set(pins)!=set(names):raise ValueError('Complete seeded import closure required')
source=None
for name,mode in names.items():
 fd=os.open(root/name,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb')as f:
  st=os.fstat(f.fileno())
  if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_nlink!=1 or stat.S_IMODE(st.st_mode)!=mode or st.st_size>262144:raise ValueError('Root module custody differs')
  raw=f.read(262145)
 if len(raw)>262144 or hashlib.sha256(raw).hexdigest()!=pins[name]:raise ValueError('Seeded import source differs')
 if name=='activate_storage.py':source=raw
current();a=types.ModuleType('pinned_activation');a.__file__=str(root/'activate_storage.py')
exec(compile(source,a.__file__,'exec'),a.__dict__)
unit='enclave-rpc-activation-launch-'+attempt+'.service';row=a.show(unit)
expected={'Id':unit,'MainPID':str(os.getpid()),'InvocationID':os.environ['INVOCATION_ID'],'Type':'exec','RuntimeMaxUSec':'10s','TimeoutStopUSec':'1s','MemoryMax':str(64<<20),'MemorySwapMax':'0','CPUQuotaPerSecUSec':'1s','KillMode':'control-group','Restart':'no','SendSIGKILL':'yes','FinalKillSignal':'9'}
if not re.fullmatch('[0-9a-f]{32}',expected['InvocationID']) or any(row.get(k)!=v for k,v in expected.items()) or Path('/proc/self/cgroup').read_text().strip()!='0::'+row['ControlGroup']:raise ValueError('Independent launch envelope differs')
raw=sys.stdin.buffer.read(65537)
if len(raw)>65536 or hashlib.sha256(raw).hexdigest()!=wanted:raise ValueError('Launch receipt bytes differ')
receipt=json.loads(raw)
current()
if a.protected_bytes(Path('/var/lib/enclave-rpc-delivery')/attempt/'receipt.json')!=raw:raise ValueError('Actual guest delivery receipt differs')
request_raw=a.protected_bytes(a.REQUEST)
if hashlib.sha256(request_raw).hexdigest()!=receipt['requestSha256']:raise ValueError('Installed request differs')
request=json.loads(request_raw);bundle=a.validate_request(request);a.private_directory(bundle)
c=a.validate_bundle(request,{n:a.protected_bytes(bundle/n)for n in ('attachment.json','server-ready.json','RESULT.json')})
if (c['attempt'],c['bootId'],c['deadlineUtcNs'])!=(attempt,boot,deadline):raise ValueError('Activation contract differs')
def owner_definition(row):
 expected={'Id':a.UNIT,'LoadState':'loaded','FragmentPath':'/etc/systemd/system/'+a.UNIT,'DropInPaths':'','NeedDaemonReload':'no','Restart':'no','KillMode':'control-group','MemoryMax':str(128<<20),'MemorySwapMax':'0','CPUQuotaPerSecUSec':'1s','Type':'notify','NotifyAccess':'main','WatchdogUSec':'2s','WatchdogSignal':'9','TimeoutStartUSec':'3s','TimeoutStopUSec':'1s','SendSIGKILL':'yes','FinalKillSignal':'9'}
 if any(row.get(k)!=v for k,v in expected.items()):raise ValueError('Activation owner definition differs')
before=a.show(a.UNIT);owner_definition(before)
if before['ActiveState'] not in ('inactive','failed') or before['MainPID']!='0' or before['ControlPID']!='0' or before['Job'] not in ('','0'):raise ValueError('Owner already active or queued')
if (a.STATE/attempt).exists():raise ValueError('Owner attempt already consumed')
state=a.consume(Path('/var/lib/enclave-rpc-activation-launch'),attempt)
a.write_new(state/'intent.json',{'attempt':attempt,'bootId':boot,'requestSha256':receipt['requestSha256'],'deliveryReceiptSha256':wanted,'deadlineUtcNs':deadline,'outcome':'unresolved-until-owner-observation'})
current()
# One submission only. The seeded owner has its own watchdog and original deadline.
a.command(['--no-block','--job-mode=fail','start',a.UNIT])
until=time.monotonic()+4
while True:
 current();row=a.show(a.UNIT);owner_definition(row)
 if row['ActiveState']=='active':break
 if row['ActiveState'] not in ('activating','inactive') or time.monotonic()>=until:raise ValueError('Owner did not arm within launch window')
 time.sleep(.025)
pid=int(row['MainPID']);inv=row['InvocationID']
if pid<=0 or not re.fullmatch('[0-9a-f]{32}',inv) or inv==before['InvocationID']:raise ValueError('Fresh owner incarnation required')
stamp=int(row['WatchdogTimestampMonotonic'])
if not 0<=time.monotonic_ns()//1000-stamp<2_000_000:raise ValueError('Fresh watchdog acknowledgment required')
fd=os.pidfd_open(pid,0)
try:
 poll=select.poll();poll.register(fd,select.POLLIN)
 def identity():
  text=(Path('/proc')/str(pid)/'stat').read_text();fields=text[text.rfind(')')+2:].split()
  if fields[0] in ('Z','X') or (Path('/proc')/str(pid)/'cgroup').read_text().strip()!='0::'+row['ControlGroup']:raise ValueError('Owner lifetime changed')
  return fields[19]
 start=identity();again=a.show(a.UNIT);owner_definition(again)
 if any(again[k]!=row[k]for k in ('MainPID','InvocationID','ControlGroup','ActiveState')) or identity()!=start or poll.poll(0):raise ValueError('Owner identity changed during observation')
 current()
 result={'schema':'owned-rpc-activation-launch-receipt/1','attempt':attempt,'bootId':boot,'requestSha256':receipt['requestSha256'],'deliveryReceiptSha256':wanted,'unitInvocation':os.environ['INVOCATION_ID'],'owner':{'unit':a.UNIT,'invocation':inv,'pid':pid,'start':start,'cgroup':row['ControlGroup']},'atUtcNs':time.time_ns(),'activationSubmitted':True,'ownerArmed':True,'storageReady':False,'rpcReady':False,'adopted':False,'writersFenced':False}
 a.write_new(state/'receipt.json',result);current()
 print(json.dumps(result),flush=True)
finally:os.close(fd)
'''


def package(config,now):
 wire,c,hostkey=d.package(config['attachmentReceipt'],config['seedReceipt'],config['guestBootId'],now)
 raw=owner.read_pinned(config['deliveryReceipt']);receipt=p.decode(raw)
 keys={'schema','attempt','bootId','wireSha256','requestSha256','unitInvocation','atUtcNs','installed','activationStarted','rpcReady'}
 if set(receipt)!=keys or receipt['schema']!='owned-rpc-activation-delivery-receipt/1':raise ValueError('Exact completed delivery receipt required')
 expected={'attempt':c['attempt'],'bootId':c['bootId'],'wireSha256':p.sha(wire),'requestSha256':p.sha(json.dumps(p.decode(wire)['request'],sort_keys=True).encode()+b'\n'),'installed':True,'activationStarted':False,'rpcReady':False}
 if any(receipt[k]!=v or type(receipt[k])is not type(v)for k,v in expected.items()):raise ValueError('Delivery receipt lineage differs')
 if not re.fullmatch('[0-9a-f]{32}',receipt['unitInvocation']) or type(receipt['atUtcNs'])is not int or not c['createdUtcNs']<=receipt['atUtcNs']<=now<c['deadlineUtcNs']:raise ValueError('Delivery receipt time/incarnation differs')
 # Both maintained receiver and sender persist exactly these bytes.
 if raw!=json.dumps(receipt,sort_keys=True).encode()+b'\n':raise ValueError('Canonical delivery receipt required')
 seed=p.decode(owner.read_pinned(config['seedReceipt']));pins={}
 for name,mode in IMPORTS.items():
  row=seed['records']['/opt/enclave-rpc/'+name];p.digest(row['sha256'])
  if row['mode']!=format(mode,'04o') or row.get('private'):raise ValueError('Seeded bootstrap closure differs')
  pins[name]=row['sha256']
 return raw,c,hostkey,pins


def remote_command(c,raw,pins):
 props=['Type=exec','MemoryMax=64M','MemorySwapMax=0','CPUQuota=100%','TasksMax=8','LimitCORE=0','RuntimeMaxSec=10','TimeoutStopSec=1','KillMode=control-group','SendSIGKILL=yes','FinalKillSignal=SIGKILL','Restart=no','UMask=0077','StateDirectory=enclave-rpc-activation-launch','StateDirectoryMode=0700']
 return ['/usr/bin/sudo','-n','/usr/bin/systemd-run','--quiet','--wait','--pipe','--unit=enclave-rpc-activation-launch-'+c['attempt']+'.service',*['--property='+v for v in props],'/usr/bin/python3','-I','-c',BOOTSTRAP,c['attempt'],c['bootId'],p.sha(raw),str(c['deadlineUtcNs']),base64.b64encode(json.dumps(pins,sort_keys=True).encode()).decode()]


def validate_receipt(r,c,raw,started,now):
 expected={'schema':'owned-rpc-activation-launch-receipt/1','attempt':c['attempt'],'bootId':c['bootId'],'requestSha256':p.decode(raw)['requestSha256'],'deliveryReceiptSha256':p.sha(raw),'activationSubmitted':True,'ownerArmed':True,'storageReady':False,'rpcReady':False,'adopted':False,'writersFenced':False}
 if set(r)!=set(expected)|{'unitInvocation','owner','atUtcNs'} or any(r[k]!=v or type(r[k])is not type(v)for k,v in expected.items()):raise ValueError('Launch observation binding differs')
 if not re.fullmatch('[0-9a-f]{32}',r['unitInvocation']) or type(r['atUtcNs'])is not int or not started<=r['atUtcNs']<=now<c['deadlineUtcNs']:raise ValueError('Launch observation time/incarnation differs')
 v=r['owner']
 if set(v)!={'unit','invocation','pid','start','cgroup'} or v['unit']!='enclave-rpc-storage-activation.service' or not re.fullmatch('[0-9a-f]{32}',v['invocation']) or type(v['pid'])is not int or v['pid']<=0 or not re.fullmatch('[0-9]+',v['start']) or not v['cgroup'].startswith('/'):raise ValueError('Exact owner observation required')


def send(config):
 if set(config)!={'deliveryReceipt','attachmentReceipt','seedReceipt','guestBootId','target','jump','sshSha256','journalRoot'}:raise ValueError('Exact activation launch configuration required')
 wall=time.time_ns();mono=time.monotonic_ns();raw,c,hostkey,pins=package(config,wall)
 p.digest(config['sshSha256'])
 if hashlib.sha256(Path('/usr/bin/ssh').read_bytes()).hexdigest()!=config['sshSha256']:raise ValueError('SSH client changed')
 target=d.endpoint(config['target'])
 if config['target']['user']!='rpcadmin':raise ValueError('Exact seeded login required')
 jump=config['jump'];jump_args=None;known=None
 if jump is not None:
  if set(jump)!={'endpoint','alias','knownHosts'}:raise ValueError('Explicit pinned jump required')
  jump_args=d.endpoint(jump['endpoint']);known=owner.read_pinned(jump['knownHosts'])
  if not known or len(known)>16384:raise ValueError('Bounded jump keys required')
 root=owner.directory(config['journalRoot']);journal=root/(c['attempt']+'-activation-launch');journal.mkdir(mode=0o700)
 def write(name,value):owner.write_new(journal/name,value if isinstance(value,bytes)else json.dumps(value,sort_keys=True).encode()+b'\n')
 def current():
  now=time.time_ns()
  if abs(now-wall-(time.monotonic_ns()-mono))>2_000_000_000:raise ValueError('Owner clock changed')
  p.validate_attachment(c,now,config['guestBootId']);return (c['deadlineUtcNs']-now)/1e9
 write('guest-known-hosts',(c['instance']+' '+hostkey+'\n').encode());argv=d.ssh_options(journal/'guest-known-hosts',c['instance'])
 if jump_args:
  write('jump-known-hosts',known);host=config['target']['host'];dest=('['+host+']'if ':'in host else host)+':'+str(config['target']['port'])
  argv+=['-oProxyCommand='+shlex.join(d.ssh_options(journal/'jump-known-hosts',jump['alias'])+['-W',dest]+jump_args)]
 argv+=target+[shlex.join(remote_command(c,raw,pins))]
 if current()<18:raise TimeoutError('Insufficient original activation window')
 write('intent.json',{'attempt':c['attempt'],'deliveryReceiptSha256':p.sha(raw),'bootstrapSha256':p.sha(BOOTSTRAP.encode()),'bootId':c['bootId'],'deadlineUtcNs':c['deadlineUtcNs'],'outcome':'unresolved-until-owner-observation'})
 for folder in (journal,root):
  fd=os.open(folder,os.O_RDONLY|os.O_DIRECTORY)
  try:os.fsync(fd)
  finally:os.close(fd)
 if package(config,time.time_ns())!=(raw,c,hostkey,pins):raise ValueError('Activation launch inputs changed')
 out=d.exchange(argv,raw,min(15,current()));r=p.decode(out);current();validate_receipt(r,c,raw,wall,time.time_ns());write('receipt.json',r)
 fd=os.open(journal,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
 current();return {'receipt':r,'storageReady':False,'rpcReady':False,'adopted':False,'remoteDeathProven':False,'writersFenced':False}

if __name__=='__main__':
 import sys
 os.umask(0o077);print(json.dumps(send(p.decode(Path(sys.argv[1]).read_bytes()))))

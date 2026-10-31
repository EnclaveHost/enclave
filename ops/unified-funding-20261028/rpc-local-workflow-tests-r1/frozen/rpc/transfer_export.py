#!/usr/bin/env python3
"""Transfer public export metadata to the independently admitted guest-key owner.

The original storage owner validates its own clock. The recipient retains that
window without treating a foreign monotonic clock as local. No key, image or
production block data is read or transferred; no guest work is submitted here.
"""
import base64,hashlib,importlib.util,ipaddress,json,os,re,shlex,time
from pathlib import Path
def load(name):
 s=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
c=load('startup_clock');d=load('deliver_activation');p=c.protocol

# These same pure validation bytes run on both ends; no arbitrary input code or
# recipient-installed module is loaded by the transported bootstrap.
VALIDATION=r'''
def decode(raw):
 def pairs(rows):
  result={}
  for key,value in rows:
   if key in result:raise ValueError('Duplicate metadata field')
   result[key]=value
  return result
 return json.loads(raw,object_pairs_hook=pairs)
def hex_digest(value):
 if not isinstance(value,str) or not re.fullmatch('[0-9a-f]{64}',value):raise ValueError('Exact public digest required')
def path_text(value):
 if not isinstance(value,str) or len(value)>1024 or not re.fullmatch('/[A-Za-z0-9_./-]+',value) or any(v in ('.','..','')for v in value[1:].split('/')):raise ValueError('Canonical public path text required')
def validate_files(files,now):
 if set(files)!={'serverContract','serverReady'}:raise ValueError('Only public export contract and readiness allowed')
 if not 0<len(files['serverContract'])<=16384 or not 0<len(files['serverReady'])<=8192:raise ValueError('Public metadata byte bound')
 server=decode(files['serverContract']);ready=decode(files['serverReady'])
 fields={'attempt','instance','bootId','createdUtcNs','deadlineUtcNs','floorMiB','reserveMiB','roles','stateParent','sourcePins','resourceArgv','startupClock'}
 if set(server)!=fields:raise ValueError('Exact maintained export contract required')
 if not re.fullmatch('[0-9a-f]{32}',server['attempt']) or not re.fullmatch('rpc-owned-[a-z0-9-]{8,64}',server['instance']) or not re.fullmatch('[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',server['bootId']):raise ValueError('Original export identity required')
 if any(type(server[k])is not int for k in ('createdUtcNs','deadlineUtcNs','floorMiB','reserveMiB')) or server['deadlineUtcNs']-server['createdUtcNs']!=900_000_000_000 or not 0<=server['createdUtcNs']<=now<server['deadlineUtcNs']:raise ValueError('Original startup window required')
 if not 27648<=server['floorMiB']<=1048576 or not 512<=server['reserveMiB']<=1048576:raise ValueError('Retained export resource contract required')
 path_text(server['stateParent']);clock=server['startupClock']
 if set(clock)!={'path','sha256'}:raise ValueError('Original clock binding required')
 path_text(clock['path']);hex_digest(clock['sha256'])
 pins=server['sourcePins']
 if not isinstance(pins,dict) or not 1<=len(pins)<=32:raise ValueError('Bounded source pins required')
 for name,value in pins.items():path_text(name);hex_digest(value)
 argv=server['resourceArgv']
 if type(argv)is not list or len(argv)!=3 or argv[0]!='/usr/bin/node' or not argv[1].endswith('/observe_resources.mjs'):raise ValueError('Maintained resource reader required')
 for value in argv:path_text(value)
 if set(server['roles'])!={'l1','base'}:raise ValueError('Both original storage roles required')
 ports=set()
 for role,row in server['roles'].items():
  if set(row)!={'parent','originals','tls','clientTls','host','port','bytes','tlsName'}:raise ValueError('Exact public export role required')
  for name in ('parent','tls','clientTls'):path_text(row[name])
  ip=ipaddress.ip_address(row['host'])
  if ip.is_loopback or ip.is_multicast or ip.is_link_local or ip.is_unspecified or str(ip)!=row['host']:raise ValueError('Explicit canonical unicast storage endpoint required')
  if type(row['port'])is not int or not 1024<=row['port']<=65535 or row['port']in ports:raise ValueError('Distinct storage ports required')
  ports.add(row['port'])
  if type(row['bytes'])is not int or row['bytes']!=4_000_000_000_000 or row['tlsName']!='rpc-storage-'+server['attempt']+'-'+role:raise ValueError('Original storage role identity required')
  if type(row['originals'])is not list or not 1<=len(row['originals'])<=3:raise ValueError('Bounded original chain required')
  for entry in row['originals']:
   if type(entry)is not list or len(entry)!=2 or type(entry[1])is not list or len(entry[1])!=5 or any(type(v)is not int or v<0 for v in entry[1]):raise ValueError('Original file metadata required')
   path_text(entry[0])
 expected={'schema':'owned-rpc-server-ready/1','attempt':server['attempt'],'instance':server['instance'],'bootId':server['bootId'],'contractSha256':hashlib.sha256(files['serverContract']).hexdigest(),'createdUtcNs':server['createdUtcNs'],'deadlineUtcNs':server['deadlineUtcNs'],'rpcReady':False}
 if set(ready)!=set(expected)|{'atUtcNs','invocation','roles'} or any(ready[k]!=v or type(ready[k])is not type(v)for k,v in expected.items()):raise ValueError('Readiness belongs to another export or window')
 if type(ready['atUtcNs'])is not int or not server['createdUtcNs']<=ready['atUtcNs']<=now or not re.fullmatch('[0-9a-f]{32}',ready['invocation']) or set(ready['roles'])!={'l1','base'}:raise ValueError('Original readiness observation required')
 for role,row in ready['roles'].items():
  expected={'export':'rpc-'+server['attempt']+'-'+role,'bytes':4_000_000_000_000,'authenticated':True,'flush':True,'fua':True}
  if set(row)!=set(expected) or any(row[k]!=v or type(row[k])is not type(v)for k,v in expected.items()):raise ValueError('Negotiated export metadata differs')
 return server
'''
exec(compile(VALIDATION,'<export-metadata-validation>','exec'))

BOOTSTRAP=r'''
import base64,hashlib,ipaddress,json,os,re,stat,subprocess,sys,time
from pathlib import Path
'''+VALIDATION+r'''
os.umask(0o077)
attempt,instance,created,deadline,wanted,root_arg,uid,boot=sys.argv[1:]
if not re.fullmatch('[0-9a-f]{32}',attempt) or not re.fullmatch('rpc-owned-[a-z0-9-]{8,64}',instance) or not all(re.fullmatch('[0-9]{1,19}',v)for v in (created,deadline,uid)):raise ValueError('Exact owner import arguments required')
hex_digest(wanted);path_text(root_arg);created=int(created);deadline=int(deadline);uid=int(uid)
if os.geteuid()!=uid or Path('/proc/sys/kernel/random/boot_id').read_text().strip()!=boot:raise ValueError('Admitted recipient boot or owner changed')
wall=time.time_ns();mono=time.monotonic_ns()
def current():
 now=time.time_ns()
 if deadline-created!=900_000_000_000 or not created<=now<deadline or abs(now-wall-(time.monotonic_ns()-mono))>2_000_000_000:raise ValueError('Original export window expired or recipient clock changed')
current();unit='enclave-rpc-export-import-'+attempt+'.service'
keys=['Id','MainPID','InvocationID','ControlGroup','Type','RuntimeMaxUSec','TimeoutStopUSec','MemoryMax','MemorySwapMax','CPUQuotaPerSecUSec','KillMode','Restart','SendSIGKILL','FinalKillSignal','TasksMax','NoNewPrivileges']
r=subprocess.run(['/usr/bin/systemctl','--user','show',unit,'--property='+','.join(keys),'--no-pager'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,check=True,timeout=2)
if len(r.stdout)>8192:raise ValueError('Unit observation bound')
rows=r.stdout.decode().splitlines();row=dict(line.split('=',1)for line in rows)
if len(rows)!=len(row):raise ValueError('Duplicate unit property')
inv=os.environ['INVOCATION_ID'];expected={'Id':unit,'MainPID':str(os.getpid()),'InvocationID':inv,'Type':'exec','RuntimeMaxUSec':'10s','TimeoutStopUSec':'1s','MemoryMax':str(64<<20),'MemorySwapMax':'0','CPUQuotaPerSecUSec':'1s','KillMode':'control-group','Restart':'no','SendSIGKILL':'yes','FinalKillSignal':'9','TasksMax':'8','NoNewPrivileges':'yes'}
if not re.fullmatch('[0-9a-f]{32}',inv) or set(row)!=set(keys) or any(row[k]!=v for k,v in expected.items()) or Path('/proc/self/cgroup').read_text().strip()!='0::'+row['ControlGroup']:raise ValueError('Independent import envelope differs')
def directory(path):
 if path.resolve(strict=True)!=path:raise ValueError('Canonical owner namespace required')
 for parent in [path,*path.parents]:
  st=parent.lstat()
  if not stat.S_ISDIR(st.st_mode) or st.st_uid not in(0,uid) or st.st_mode&0o022:raise ValueError('Owner namespace authority differs')
 if stat.S_IMODE(path.stat().st_mode)!=0o700 or path.stat().st_uid!=uid:raise ValueError('Private recipient directory required')
def sync(path):
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(fd)
 finally:os.close(fd)
def write(path,data):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb')as f:f.write(data);f.flush();os.fsync(f.fileno())
 sync(path.parent)
root=Path(root_arg);directory(root)
raw=sys.stdin.buffer.read(65537)
if len(raw)>65536 or hashlib.sha256(raw).hexdigest()!=wanted:raise ValueError('Exact bounded public input required')
wire=decode(raw)
if set(wire)!={'schema','files'} or wire['schema']!='owned-rpc-export-transfer/1' or set(wire['files'])!={'serverContract','serverReady'}:raise ValueError('Fixed public export transfer required')
files={k:base64.b64decode(v,validate=True)for k,v in wire['files'].items()}
server=validate_files(files,time.time_ns())
if (server['attempt'],server['instance'],server['createdUtcNs'],server['deadlineUtcNs'])!=(attempt,instance,created,deadline):raise ValueError('Original export metadata differs')
current();folder=root/attempt;folder.mkdir(mode=0o700);sync(root)
write(folder/'intent.json',json.dumps({'attempt':attempt,'wireSha256':wanted,'createdUtcNs':created,'deadlineUtcNs':deadline,'recipientBootId':boot,'unitInvocation':inv},sort_keys=True).encode()+b'\n')
names={'serverContract':'server-contract.json','serverReady':'server-ready.json'};bindings={}
for key,name in names.items():
 current();path=folder/name;write(path,files[key])
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb')as f:
  st=os.fstat(f.fileno());data=f.read(16385)
  if st.st_uid!=uid or st.st_nlink!=1 or not stat.S_ISREG(st.st_mode) or stat.S_IMODE(st.st_mode)!=0o600 or data!=files[key]:raise ValueError('Imported metadata readback differs')
 bindings[key]={'path':str(path),'sha256':hashlib.sha256(data).hexdigest()}
current()
receipt={'schema':'owned-rpc-export-import/1','attempt':attempt,'instance':instance,'wireSha256':wanted,'createdUtcNs':created,'deadlineUtcNs':deadline,'recipientBootId':boot,'recipientUid':uid,'unitInvocation':inv,'atUtcNs':time.time_ns(),'files':bindings,'imported':True,'guestSubmitted':False,'rpcReady':False,'writersFenced':False}
write(folder/'receipt.json',json.dumps(receipt,sort_keys=True).encode()+b'\n');current();print(json.dumps(receipt),flush=True)
'''


def package(config):
 original=c.validate(config['clock'])
 files={k:c.read_pinned(config[k])for k in ('serverContract','serverReady')};server=validate_files(files,time.time_ns())
 for key in ('attempt','instance','bootId','createdUtcNs','deadlineUtcNs'):
  if server[key]!=original[key] or type(server[key])is not type(original[key]):raise ValueError('Export differs from original owner clock')
 if server['startupClock']!=config['clock']:raise ValueError('Export uses another startup clock binding')
 raw=c.encode({'schema':'owned-rpc-export-transfer/1','files':{k:base64.b64encode(v).decode()for k,v in files.items()}})
 if len(raw)>65536:raise ValueError('Public transfer bound')
 return original,files,raw


def remote_command(original,config,raw):
 props=['Type=exec','MemoryMax=64M','MemorySwapMax=0','CPUQuota=100%','TasksMax=8','LimitCORE=0','RuntimeMaxSec=10','TimeoutStopSec=1','KillMode=control-group','SendSIGKILL=yes','FinalKillSignal=SIGKILL','Restart=no','UMask=0077','NoNewPrivileges=yes']
 return ['/usr/bin/systemd-run','--user','--quiet','--wait','--pipe','--unit=enclave-rpc-export-import-'+original['attempt']+'.service',*['--property='+v for v in props],'/usr/bin/python3','-I','-c',BOOTSTRAP,original['attempt'],original['instance'],str(original['createdUtcNs']),str(original['deadlineUtcNs']),p.sha(raw),config['recipientRoot'],str(config['recipientUid']),config['recipientBootId']]


def local_config(config):
 # Local mode derives authority from this process and the actual original boot.
 # Caller-supplied recipient identity cannot impersonate a different owner.
 if 'recipientUid' in config or 'recipientBootId' in config:raise ValueError('Local recipient identity is derived, not supplied')
 original=c.validate(config['clock'])
 boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
 if original['bootId']!=boot:raise ValueError('Original local owner boot changed')
 return dict(config,recipientUid=os.geteuid(),recipientBootId=boot)


def transfer(config):
 return _transfer(config,False)


def transfer_local(config):
 return _transfer(local_config(config),True)


def _transfer(config,local):
 fields={'clock','serverContract','serverReady','recipientRoot','recipientUid','recipientBootId'}
 if not local:fields|={'target','knownHosts','hostAlias','sshSha256'}
 if set(config)!=fields:raise ValueError('Exact owner transfer configuration required')
 original,files,raw=package(config);path_text(config['recipientRoot']);p.boot(config['recipientBootId'])
 if type(config['recipientUid'])is not int or not 0<=config['recipientUid']<=2147483647:raise ValueError('Exact admitted recipient UID required')
 known=None
 if not local:
  p.digest(config['sshSha256'])
  if p.sha(Path('/usr/bin/ssh').read_bytes())!=config['sshSha256']:raise ValueError('SSH client changed')
  target=d.endpoint(config['target']);known=c.read_pinned(config['knownHosts']);parts=known.decode('ascii').strip().split()
  if len(parts)!=3 or parts[:2]!=[config['hostAlias'],'ssh-ed25519'] or known.count(b'\n')>1:raise ValueError('One pinned recipient host key required')
  key=base64.b64decode(parts[2],validate=True)
  if len(key)!=51 or key[:19]!=b'\0\0\0\x0bssh-ed25519\0\0\0\x20':raise ValueError('Recipient host key differs')
 parent=c.directory(Path(config['clock']['path']).parent);root=parent/'guest-export-transfer';root.mkdir(mode=0o700);c.sync_directory(parent)
 command=remote_command(original,config,raw)
 if local:
  argv=command
 else:
  c.write_new(root/'known-hosts',known)
  argv=d.ssh_options(root/'known-hosts',config['hostAlias'])+target+[shlex.join(command)]
 if c.remaining(config['clock'])<18:raise TimeoutError('Insufficient original import window')
 c.write_new(root/'intent.json',c.encode({'attempt':original['attempt'],'wireSha256':p.sha(raw),'configurationSha256':p.sha(c.encode(config)),'bootstrapSha256':p.sha(BOOTSTRAP.encode()),'deadlineUtcNs':original['deadlineUtcNs'],'outcome':'unresolved-until-exact-import','transport':'local-user-unit' if local else 'pinned-ssh'}))
 if package(config)!=(original,files,raw) or (not local and c.read_pinned(config['knownHosts'])!=known):raise ValueError('Transfer inputs changed')
 started=time.time_ns();reply=d.exchange(argv,raw,min(15,c.remaining(config['clock'])));c.validate(config['clock']);r=p.decode(reply)
 expected={'schema':'owned-rpc-export-import/1','attempt':original['attempt'],'instance':original['instance'],'wireSha256':p.sha(raw),'createdUtcNs':original['createdUtcNs'],'deadlineUtcNs':original['deadlineUtcNs'],'recipientBootId':config['recipientBootId'],'recipientUid':config['recipientUid'],'imported':True,'guestSubmitted':False,'rpcReady':False,'writersFenced':False}
 if set(r)!=set(expected)|{'unitInvocation','atUtcNs','files'} or any(r[k]!=v or type(r[k])is not type(v)for k,v in expected.items()):raise ValueError('Import observation differs')
 if not re.fullmatch('[0-9a-f]{32}',r['unitInvocation']) or type(r['atUtcNs'])is not int or not started<=r['atUtcNs']<=time.time_ns()<original['deadlineUtcNs']:raise ValueError('Fresh original import observation required')
 bindings={k:{'path':config['recipientRoot']+'/'+original['attempt']+'/'+name,'sha256':p.sha(files[k])}for k,name in [('serverContract','server-contract.json'),('serverReady','server-ready.json')]}
 if r['files']!=bindings:raise ValueError('Exact imported file paths and hashes required')
 receipt=c.write_new(root/'receipt.json',c.encode(r));c.validate(config['clock'])
 return {'receipt':receipt,'recipientFiles':bindings,'guestSubmitted':False,'rpcReady':False,'remoteDeathProven':False,'writersFenced':False}


if __name__=='__main__':
 import sys
 os.umask(0o077);print(json.dumps(transfer(p.decode(Path(sys.argv[1]).read_bytes()))))

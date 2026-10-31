#!/usr/bin/env python3
"""One-shot owner-to-guest public bundle delivery over pinned SSH.

Run only inside an independently admitted owner envelope. This never starts
activation, mounts or clients. Unknown submission outcomes remain consumed/held.
Local SSH cleanup is not remote process death or storage/provider fencing.
"""
import base64,hashlib,importlib.util,ipaddress,json,os,re,selectors,shlex,signal,stat,subprocess,time
from pathlib import Path

def load(name):
 spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
p=load('storage_protocol');owner=load('prepare_attachment')
FILES={'/opt/enclave-rpc/'+n:(0o644 if n=='storage_protocol.py' else 0o755) for n in ['activate_storage.py','attach_storage.py','storage_protocol.py','identity.py']}
FILES.update({'/etc/systemd/system/'+n:0o644 for n in ['enclave-rpc-storage-activation.service','enclave-rpc-attach-l1.service','enclave-rpc-attach-base.service']})

def package(bundle_receipt,seed_receipt,guest_boot,now):
 result_raw=owner.read_pinned(bundle_receipt);result=p.decode(result_raw);seed=p.decode(owner.read_pinned(seed_receipt))
 if result.get('schema')!='owned-rpc-attachment-bundle/1' or set(result['files'])!={'attachment.json','server-ready.json'}:raise ValueError('Exact prepared bundle required')
 folder=Path(bundle_receipt['path']).parent;files={'RESULT.json':result_raw}
 for name,sha in result['files'].items():files[name]=owner.read_pinned({'path':str(folder/name),'sha256':sha})
 c=p.decode(files['attachment.json']);p.validate_attachment(c,now,guest_boot);p.validate_ready(p.decode(files['server-ready.json']),c,now)
 if c['serverReadySha256']!=p.sha(files['server-ready.json']):raise ValueError('Server receipt changed')
 for left,right in [('attempt','attempt'),('instance','instance'),('guestBootId','bootId'),('createdUtcNs','createdUtcNs'),('deadlineUtcNs','deadlineUtcNs')]:
  if result[left]!=c[right]:raise ValueError('Bundle metadata differs')
 if any(result[k] is not False for k in ['storageAttached','rpcReady','writersFenced']):raise ValueError('Bundle makes readiness claim')
 if seed['instance']!=c['instance'] or seed['readbackVerified'] is not True or seed['seedContainsPrivateCredentials'] is not True:raise ValueError('Exact private seed receipt required')
 credentials=seed['credentialPublic']
 if credentials['attempt']!=c['attempt']:raise ValueError('Seed credentials belong to another attempt')
 hostkey=credentials['sshHostPublicKey'].strip();parts=hostkey.split()
 if len(parts)!=2 or parts[0]!='ssh-ed25519':raise ValueError('Exact seeded Ed25519 host key required')
 key=base64.b64decode(parts[1],validate=True)
 if len(key)!=51 or key[:19]!=b'\0\0\0\x0bssh-ed25519\0\0\0\x20':raise ValueError('Malformed seeded host key')
 fingerprint='SHA256:'+base64.b64encode(hashlib.sha256(key).digest()).decode().rstrip('=')
 if fingerprint!=credentials['sshHostFingerprint']:raise ValueError('Seed host key fingerprint differs')
 pins={}
 for path,mode in FILES.items():
  row=seed['records'][path];p.digest(row['sha256'])
  if row['mode']!=format(mode,'04o') or row.get('private'):raise ValueError('Seed activation runtime differs')
  pins[path]=row['sha256']
 request={'bundle':'/run/enclave-rpc-import/'+c['attempt'],'resultSha256':p.sha(result_raw),'runtimePins':pins}
 wire={'schema':'owned-rpc-activation-delivery/1','request':request,'files':{name:base64.b64encode(raw).decode() for name,raw in files.items()}}
 raw=json.dumps(wire,sort_keys=True,separators=(',',':')).encode();p.decode(raw)
 return raw,c,hostkey


def endpoint(row):
 if set(row)!={'host','port','user','identityFile'}:raise ValueError('Exact explicit SSH endpoint required')
 ip=ipaddress.ip_address(row['host'])
 if ip.is_unspecified or ip.is_multicast or ip.is_link_local:raise ValueError('Explicit unicast SSH endpoint required')
 if type(row['port']) is not int or not 1<=row['port']<=65535 or not re.fullmatch('[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}',row['user']):raise ValueError('SSH endpoint differs')
 path=Path(row['identityFile'])
 if not path.is_absolute() or path.resolve(strict=True)!=path:raise ValueError('Canonical local identity required')
 owner.directory(path.parent);st=path.stat()
 if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.geteuid() or st.st_nlink!=1 or stat.S_IMODE(st.st_mode)!=0o600:raise ValueError('Private local SSH identity required')
 # Normal SSH uses the local key. This code never reads, copies or exports it.
 return ['-p',str(row['port']),'-l',row['user'],'-i',str(path),row['host']]


def ssh_options(known,alias):
 if not re.fullmatch('[a-zA-Z0-9_.-]{1,100}',alias):raise ValueError('Explicit host-key alias required')
 return ['/usr/bin/ssh','-F','/dev/null','-T','-oBatchMode=yes','-oIdentitiesOnly=yes','-oStrictHostKeyChecking=yes',
  '-oUserKnownHostsFile='+str(known),'-oGlobalKnownHostsFile=/dev/null','-oHostKeyAlias='+alias,'-oHostKeyAlgorithms=ssh-ed25519',
  '-oUpdateHostKeys=no','-oVerifyHostKeyDNS=no','-oCheckHostIP=no','-oPasswordAuthentication=no','-oKbdInteractiveAuthentication=no',
  '-oForwardAgent=no','-oForwardX11=no','-oClearAllForwardings=yes','-oControlMaster=no','-oControlPath=none',
  '-oConnectionAttempts=1','-oConnectTimeout=3','-oServerAliveInterval=1','-oServerAliveCountMax=2']


def remote_command(attempt,sha):
 p.identity(attempt,'rpc-owned-delivery');p.digest(sha)
 properties=['Type=exec','MemoryMax=64M','MemorySwapMax=0','CPUQuota=100%','TasksMax=8','LimitCORE=0','RuntimeMaxSec=5',
  'TimeoutStopSec=1','KillMode=control-group','SendSIGKILL=yes','FinalKillSignal=SIGKILL','Restart=no','UMask=0077',
  'PrivateNetwork=yes','ProtectSystem=strict','ProtectHome=yes','NoNewPrivileges=yes',
  'RuntimeDirectory=enclave-rpc-import','RuntimeDirectoryMode=0700','RuntimeDirectoryPreserve=yes',
  'StateDirectory=enclave-rpc-delivery','StateDirectoryMode=0700','ReadWritePaths=/etc/enclave-rpc']
 return ['/usr/bin/sudo','-n','/usr/bin/systemd-run','--quiet','--wait','--pipe','--unit=enclave-rpc-delivery-'+attempt+'.service',
  *['--property='+v for v in properties],'/usr/bin/python3','-I','/opt/enclave-rpc/activate_storage.py','receive',attempt,sha]


def exchange(argv,raw,seconds):
 """Bounded local SSH group; never infer remote death from transport exit."""
 child=subprocess.Popen(argv,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,bufsize=0)
 sel=selectors.DefaultSelector();buffers={'stdout':bytearray(),'stderr':bytearray()};sent=0;reason=None;rc=None;end=time.monotonic()+seconds
 try:
  for name in ['stdin','stdout','stderr']:
   stream=getattr(child,name);os.set_blocking(stream.fileno(),False);sel.register(stream,selectors.EVENT_WRITE if name=='stdin' else selectors.EVENT_READ,name)
  while sel.get_map():
   if time.monotonic()>=end:reason='transport-timeout';break
   for key,_ in sel.select(min(.05,max(0,end-time.monotonic()))):
    if key.data=='stdin':
     try:sent+=os.write(key.fd,raw[sent:sent+16384])
     except (BlockingIOError,InterruptedError):continue
     except BrokenPipeError:reason='input-closed';sel.unregister(key.fileobj);key.fileobj.close();continue
     if sent==len(raw):sel.unregister(key.fileobj);key.fileobj.close()
    else:
     try:data=os.read(key.fd,4096)
     except (BlockingIOError,InterruptedError):continue
     if not data:sel.unregister(key.fileobj);key.fileobj.close();continue
     buffers[key.data].extend(data)
     if len(buffers[key.data])>8192:raise ValueError('SSH output bound')
  # Wait without reaping: reserve the PID through local process-group cleanup.
  while os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT) is None:
   if time.monotonic()>=end:reason=reason or 'transport-timeout';break
   time.sleep(.01)
 finally:
  os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT)
  try:os.killpg(child.pid,signal.SIGKILL)
  except ProcessLookupError:pass
  rc=child.wait(timeout=2);sel.close()
  for name in ['stdin','stdout','stderr']:
   stream=getattr(child,name)
   if not stream.closed:stream.close()
 if reason or rc!=0:raise RuntimeError('Delivery outcome unresolved: '+str(reason or rc))
 return bytes(buffers['stdout'])


def send(config):
 expected={'bundleReceipt','seedReceipt','guestBootId','target','jump','sshSha256','journalRoot'}
 if set(config)!=expected:raise ValueError('Exact one-shot delivery configuration required')
 start_wall=time.time_ns();start_mono=time.monotonic_ns()
 raw,c,hostkey=package(config['bundleReceipt'],config['seedReceipt'],config['guestBootId'],start_wall)
 p.digest(config['sshSha256'])
 if hashlib.sha256(Path('/usr/bin/ssh').read_bytes()).hexdigest()!=config['sshSha256']:raise ValueError('SSH client changed')
 target=endpoint(config['target'])
 if config['target']['user']!='rpcadmin':raise ValueError('Exact seeded login required')
 jump=config['jump'];jump_args=None;known=None
 if jump is not None:
  if set(jump)!={'endpoint','alias','knownHosts'}:raise ValueError('Explicit pinned jump required')
  jump_args=endpoint(jump['endpoint']);known=owner.read_pinned(jump['knownHosts'])
  if not known or len(known)>16384:raise ValueError('Bounded jump host keys required')
 root=owner.directory(config['journalRoot']);journal=root/c['attempt'];journal.mkdir(mode=0o700)
 def write(name,value):owner.write_new(journal/name,value if isinstance(value,bytes) else json.dumps(value,sort_keys=True).encode()+b'\n')
 def current():
  now=time.time_ns();elapsed=time.monotonic_ns()-start_mono
  if abs(now-start_wall-elapsed)>2_000_000_000:raise ValueError('Owner clock changed')
  p.validate_attachment(c,now,config['guestBootId']);return (c['deadlineUtcNs']-now)/1e9
 write('guest-known-hosts',(c['instance']+' '+hostkey+'\n').encode())
 argv=ssh_options(journal/'guest-known-hosts',c['instance'])
 if jump_args:
  write('jump-known-hosts',known)
  host=config['target']['host'];destination=('['+host+']' if ':' in host else host)+':'+str(config['target']['port'])
  proxy=ssh_options(journal/'jump-known-hosts',jump['alias'])+['-W',destination]+jump_args
  argv+=['-oProxyCommand='+shlex.join(proxy)]
 argv+=target+[shlex.join(remote_command(c['attempt'],p.sha(raw)))]
 if current()<8:raise TimeoutError('Insufficient original delivery window')
 write('intent.json',{'attempt':c['attempt'],'bootId':c['bootId'],'wireSha256':p.sha(raw),'atUtcNs':time.time_ns(),'deadlineUtcNs':c['deadlineUtcNs'],'outcome':'unresolved-until-exact-receipt'})
 for path in [journal,root]:
  fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
  try:os.fsync(fd)
  finally:os.close(fd)
 # Exactly one call. Any exception leaves the consumed journal untouched.
 again,_,_=package(config['bundleReceipt'],config['seedReceipt'],config['guestBootId'],time.time_ns())
 if again!=raw:raise ValueError('Prepared delivery changed before submission')
 out=exchange(argv,raw,min(8,current()));receipt=p.decode(out);current()
 request=p.decode(raw)['request'];request_raw=json.dumps(request,sort_keys=True).encode()+b'\n'
 wanted={'schema':'owned-rpc-activation-delivery-receipt/1','attempt':c['attempt'],'bootId':c['bootId'],'wireSha256':p.sha(raw),
  'requestSha256':p.sha(request_raw),'installed':True,'activationStarted':False,'rpcReady':False}
 if set(receipt)!=set(wanted)|{'unitInvocation','atUtcNs'} or any(receipt[k]!=v or type(receipt[k]) is not type(v) for k,v in wanted.items()):raise ValueError('Exact installed receipt differs')
 if not re.fullmatch('[0-9a-f]{32}',receipt['unitInvocation']) or type(receipt['atUtcNs']) is not int or not start_wall<=receipt['atUtcNs']<=time.time_ns()<c['deadlineUtcNs']:raise ValueError('Fresh delivery incarnation/time required')
 write('receipt.json',receipt)
 fd=os.open(journal,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
 current()
 return {'receipt':receipt,'remoteDeathProven':False,'activationStarted':False,'writersFenced':False}

if __name__=='__main__':
 import sys
 os.umask(0o077);print(json.dumps(send(p.decode(Path(sys.argv[1]).read_bytes()))))

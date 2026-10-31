#!/usr/bin/env python3
"""Collect exact public activation inputs after a bounded, authenticated live read.

Does not start services, adopt owners or read/export private credentials. Existing
seeded validation may read guest-local credentials internally. A successful read
is an observation; runtime submission must revalidate all lifetimes itself.
"""
import base64,hashlib,importlib.util,json,os,re,shlex,time
from pathlib import Path
s=importlib.util.spec_from_file_location('activation_launch',Path(__file__).with_name('launch_activation.py'))
x=importlib.util.module_from_spec(s);s.loader.exec_module(x)
d=x.d;p=x.p;owner=x.owner

BOOTSTRAP=x.BOOTSTRAP_PREFIX+r'''
unit='enclave-rpc-activation-observe-'+attempt+'.service';row=a.show(unit)
expected={'Id':unit,'MainPID':str(os.getpid()),'InvocationID':os.environ['INVOCATION_ID'],'Type':'exec','RuntimeMaxUSec':'95s','TimeoutStopUSec':'1s','MemoryMax':str(64<<20),'MemorySwapMax':'0','CPUQuotaPerSecUSec':'1s','KillMode':'control-group','Restart':'no','SendSIGKILL':'yes','FinalKillSignal':'9'}
if not re.fullmatch('[0-9a-f]{32}',expected['InvocationID']) or any(row.get(k)!=v for k,v in expected.items()) or Path('/proc/self/cgroup').read_text().strip()!='0::'+row['ControlGroup']:raise ValueError('Independent observation envelope differs')
raw=sys.stdin.buffer.read(8193)
if len(raw)>8192 or hashlib.sha256(raw).hexdigest()!=wanted:raise ValueError('Launch observation bytes differ')
launch=json.loads(raw);binding=launch['owner'];current()
if a.protected_bytes(Path('/var/lib/enclave-rpc-activation-launch')/attempt/'receipt.json')!=raw:raise ValueError('Actual launch receipt differs')
request_raw=a.protected_bytes(a.REQUEST);request=json.loads(request_raw)
if hashlib.sha256(request_raw).hexdigest()!=launch['requestSha256']:raise ValueError('Activation request differs')
bundle=a.validate_request(request);a.private_directory(bundle)
c=a.validate_bundle(request,{n:a.protected_bytes(bundle/n)for n in ('attachment.json','server-ready.json','RESULT.json')})
if (c['attempt'],c['bootId'],c['deadlineUtcNs'])!=(attempt,boot,deadline):raise ValueError('Original activation binding differs')
state=a.STATE/attempt;a.private_directory(state)
intent=json.loads(a.protected_bytes(state/'intent.json'))
if any(intent[k]!=v for k,v in {'attempt':attempt,'bootId':boot,'requestSha256':launch['requestSha256'],'unitInvocation':binding['invocation'],'deadlineUtcNs':deadline}.items()):raise ValueError('Owner intent differs')
contract_raw=a.protected_bytes(a.CONFIG/'attachment.json');contract_sha=hashlib.sha256(contract_raw).hexdigest()
if json.loads(contract_raw)!=c:raise ValueError('Installed attachment differs')
pid=binding['pid'];fd=os.pidfd_open(pid,0)
try:
 poll=select.poll();poll.register(fd,select.POLLIN)
 def check():
  current()
  if poll.poll(0):raise ValueError('Original activation owner exited')
  row=a.show(a.UNIT)
  expected={'Id':a.UNIT,'LoadState':'loaded','FragmentPath':'/etc/systemd/system/'+a.UNIT,'DropInPaths':'','NeedDaemonReload':'no','Restart':'no','KillMode':'control-group','MemoryMax':str(128<<20),'MemorySwapMax':'0','CPUQuotaPerSecUSec':'1s','Type':'notify','NotifyAccess':'main','WatchdogUSec':'2s','WatchdogSignal':'9','TimeoutStartUSec':'3s','TimeoutStopUSec':'1s','SendSIGKILL':'yes','FinalKillSignal':'9','ActiveState':'active','MainPID':str(pid),'InvocationID':binding['invocation'],'ControlGroup':binding['cgroup']}
  if any(row.get(k)!=v for k,v in expected.items()):raise ValueError('Original owner identity or loaded definition differs')
  if not 0<=time.monotonic_ns()//1000-int(row['WatchdogTimestampMonotonic'])<2_000_000:raise ValueError('Owner watchdog stale')
  proc=Path('/proc')/str(pid);text=(proc/'stat').read_text();fields=text[text.rfind(')')+2:].split()
  if fields[0]in('Z','X') or fields[19]!=binding['start'] or (proc/'cgroup').read_text().strip()!='0::'+binding['cgroup']:raise ValueError('Original owner process changed')
  if a.protected_bytes(a.REQUEST)!=request_raw or a.protected_bytes(a.CONFIG/'attachment.json')!=contract_raw:raise ValueError('Activation inputs changed')
  current()
 check();until=time.monotonic()+90
 while not (state/'ready.json').exists():
  check()
  if time.monotonic()>=until:raise TimeoutError('Activation readiness observation expired')
  time.sleep(.1)
 ready_raw=a.protected_bytes(state/'ready.json');ready=json.loads(ready_raw)
 expected={'attempt':attempt,'bootId':boot,'requestSha256':launch['requestSha256'],'contractSha256':contract_sha,'rpcReady':False,'writersFenced':False}
 if set(ready)!=set(expected)|{'roles','atUtcNs'} or any(ready[k]!=v or type(ready[k])is not type(v)for k,v in expected.items()) or set(ready['roles'])!={'l1','base'}:raise ValueError('Exact activation readiness binding required')
 if type(ready['atUtcNs'])is not int or not c['createdUtcNs']<=ready['atUtcNs']<=time.time_ns()<deadline:raise ValueError('Ready receipt time differs')
 for role in a.ROLES:
  check()
  if a.current_ready(role,c,contract_sha,a.show('enclave-rpc-attach-'+role+'.service'))!=ready['roles'][role]:raise ValueError('Actual kernel attachment differs')
 check()
 if a.protected_bytes(state/'ready.json')!=ready_raw:raise ValueError('Readiness changed during observation')
 files=[{'name':name,'sha256':hashlib.sha256(data).hexdigest(),'base64':base64.b64encode(data).decode()}for name,data in [('activation-request.json',request_raw),('activation-ready.json',ready_raw)]]
 result={'schema':'owned-rpc-activation-observation/1','attempt':attempt,'bootId':boot,'launchReceiptSha256':wanted,'owner':binding,'unitInvocation':os.environ['INVOCATION_ID'],'atUtcNs':time.time_ns(),'files':files,'kernelAttachmentsObserved':True,'rpcReady':False,'adopted':False,'writersFenced':False}
 output=json.dumps(result).encode()
 if len(output)+1>8192:raise ValueError('Bounded observation output exceeded')
 current();print(output.decode(),flush=True)
finally:os.close(fd)
'''


def package(config,now):
 raw,c,hostkey,pins=x.package(config,now)
 launch_raw=owner.read_pinned(config['launchReceipt']);r=p.decode(launch_raw)
 x.validate_receipt(r,c,raw,c['createdUtcNs'],now)
 if launch_raw!=json.dumps(r,sort_keys=True).encode()+b'\n':raise ValueError('Canonical launch receipt required')
 return launch_raw,c,hostkey,pins


def remote_command(c,raw,pins):
 props=['Type=exec','MemoryMax=64M','MemorySwapMax=0','CPUQuota=100%','TasksMax=8','LimitCORE=0','RuntimeMaxSec=95','TimeoutStopSec=1','KillMode=control-group','SendSIGKILL=yes','FinalKillSignal=SIGKILL','Restart=no','UMask=0077']
 return ['/usr/bin/sudo','-n','/usr/bin/systemd-run','--quiet','--wait','--pipe','--unit=enclave-rpc-activation-observe-'+c['attempt']+'.service',*['--property='+v for v in props],'/usr/bin/python3','-I','-c',BOOTSTRAP,c['attempt'],c['bootId'],p.sha(raw),str(c['deadlineUtcNs']),base64.b64encode(json.dumps(pins,sort_keys=True).encode()).decode()]


def validate_receipt(r,c,raw,started,now):
 launch=p.decode(raw)
 expected={'schema':'owned-rpc-activation-observation/1','attempt':c['attempt'],'bootId':c['bootId'],'launchReceiptSha256':p.sha(raw),'owner':launch['owner'],'kernelAttachmentsObserved':True,'rpcReady':False,'adopted':False,'writersFenced':False}
 if set(r)!=set(expected)|{'unitInvocation','atUtcNs','files'} or any(r[k]!=v or type(r[k])is not type(v)for k,v in expected.items()):raise ValueError('Activation observation differs')
 if not re.fullmatch('[0-9a-f]{32}',r['unitInvocation']) or type(r['atUtcNs'])is not int or not started<=r['atUtcNs']<=now<c['deadlineUtcNs']:raise ValueError('Observation time/incarnation differs')
 if type(r['files'])is not list or len(r['files'])!=2:raise ValueError('Exact public observation files required')
 files={}
 for f in r['files']:
  if set(f)!={'name','sha256','base64'} or f['name']not in ('activation-request.json','activation-ready.json') or f['name']in files:raise ValueError('Unexpected or duplicate observation file')
  data=base64.b64decode(f['base64'],validate=True)
  if not 0<len(data)<=4096 or p.sha(data)!=f['sha256']:raise ValueError('Observation file size/hash differs')
  files[f['name']]=data
 request=p.decode(files['activation-request.json']);ready=p.decode(files['activation-ready.json'])
 if (p.sha(files['activation-request.json'])!=launch['requestSha256'] or ready['requestSha256']!=launch['requestSha256']
     or ready['attempt']!=c['attempt'] or ready['bootId']!=c['bootId'] or ready['rpcReady']is not False or ready['writersFenced']is not False
     or set(ready['roles'])!={'l1','base'} or Path(request['bundle']).name!=c['attempt']):raise ValueError('Observed activation lineage differs')
 return files


def observe(config):
 if set(config)!={'launchReceipt','deliveryReceipt','attachmentReceipt','seedReceipt','guestBootId','target','jump','sshSha256','journalRoot'}:raise ValueError('Exact observation configuration required')
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
 root=owner.directory(config['journalRoot']);journal=root/(c['attempt']+'-activation-observe');journal.mkdir(mode=0o700)
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
 if current()<103:raise TimeoutError('Insufficient original observation window')
 write('intent.json',{'attempt':c['attempt'],'launchReceiptSha256':p.sha(raw),'bootstrapSha256':p.sha(BOOTSTRAP.encode()),'bootId':c['bootId'],'deadlineUtcNs':c['deadlineUtcNs']})
 for folder in (journal,root):
  fd=os.open(folder,os.O_RDONLY|os.O_DIRECTORY)
  try:os.fsync(fd)
  finally:os.close(fd)
 if package(config,time.time_ns())!=(raw,c,hostkey,pins):raise ValueError('Observation inputs changed')
 out=d.exchange(argv,raw,min(100,current()));r=p.decode(out);current();files=validate_receipt(r,c,raw,wall,time.time_ns())
 for name,data in files.items():write(name,data)
 write('receipt.json',r)
 fd=os.open(journal,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
 current()
 return {'receipt':r,'activationRequest':{'path':str(journal/'activation-request.json'),'sha256':p.sha(files['activation-request.json'])},'activationReady':{'path':str(journal/'activation-ready.json'),'sha256':p.sha(files['activation-ready.json'])},'rpcReady':False,'adopted':False,'remoteDeathProven':False,'writersFenced':False}

if __name__=='__main__':
 import sys
 os.umask(0o077);print(json.dumps(observe(p.decode(Path(sys.argv[1]).read_bytes()))))

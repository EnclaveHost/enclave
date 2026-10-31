#!/usr/bin/env python3
"""Invoke the guest-key-owner workflow once over the original owner's SSH channel.

Requires already qualified protected source/profile staging on the recipient,
and the completed two-file export import. This sends only public endpoint and
path/hash metadata. Private guest SSH credentials stay on the recipient.
"""
import base64
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import time


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


t = load('transfer_export')
e = load('windows_endpoint')
c, d, p = t.c, t.d, t.p
SOURCE_NAMES = ('run_guest_workflow.py', 'startup_clock.py', 'observe_guest.py', 'prepare_attachment.py',
                'deliver_activation.py', 'launch_activation.py', 'observe_activation.py', 'prepare_runtime.py',
                'deliver_runtime.py', 'storage_protocol.py', 'guest/start_runtime.py', 'guest/activate_storage.py',
                'guest/attach_storage.py', 'guest/identity.py')
PROFILE_FIELDS = ('seedReceipt', 'imageReceipt', 'credentialReceipt', 'guestIdentityFile', 'jump',
                  'sshSha256', 'journalRoot', 'ownerBootId', 'vmAttempt')

BOOTSTRAP = r'''
import base64,hashlib,importlib.util,json,os,re,stat,subprocess,sys,time
from pathlib import Path
sys.dont_write_bytecode=True
os.umask(0o077)
attempt,instance,vm,created,deadline,wanted,root_arg,uid,boot,source_arg,pins64,profile_path,profile_sha=sys.argv[1:]
if not all(re.fullmatch('[0-9a-f]{32}',v)for v in(attempt,vm)) or not re.fullmatch('rpc-owned-[a-z0-9-]{8,64}',instance):raise ValueError('Exact original workflow identity required')
if not all(re.fullmatch('[0-9]{1,19}',v)for v in(created,deadline,uid)) or not all(re.fullmatch('[0-9a-f]{64}',v)for v in(wanted,profile_sha)):raise ValueError('Exact workflow window/pins required')
created=int(created);deadline=int(deadline);uid=int(uid)
if os.geteuid()!=uid or Path('/proc/sys/kernel/random/boot_id').read_text().strip()!=boot:raise ValueError('Admitted key-owner UID/boot changed')
wall=time.time_ns();mono=time.monotonic_ns()
def current():
 now=time.time_ns()
 if deadline-created!=900_000_000_000 or not created<=now<deadline or abs(now-wall-(time.monotonic_ns()-mono))>2_000_000_000:raise ValueError('Original workflow window expired or clock changed')
current()
unit='enclave-rpc-guest-workflow-'+attempt+'.service'
keys=['Id','MainPID','InvocationID','ControlGroup','Type','RuntimeMaxUSec','TimeoutStopUSec','MemoryMax','MemorySwapMax','CPUQuotaPerSecUSec','KillMode','Restart','SendSIGKILL','FinalKillSignal','TasksMax','NoNewPrivileges','ExecMainStartTimestampMonotonic']
r=subprocess.run(['/usr/bin/systemctl','--user','show',unit,'--property='+','.join(keys),'--no-pager'],check=True,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=2)
if len(r.stdout)>8192:raise ValueError('Workflow envelope read bound')
rows=r.stdout.decode().splitlines();row=dict(line.split('=',1)for line in rows);inv=os.environ.get('INVOCATION_ID','')
expected={'Id':unit,'MainPID':str(os.getpid()),'InvocationID':inv,'Type':'exec','RuntimeMaxUSec':'4min','TimeoutStopUSec':'1s','MemoryMax':str(256<<20),'MemorySwapMax':'0','CPUQuotaPerSecUSec':'1s','KillMode':'control-group','Restart':'no','SendSIGKILL':'yes','FinalKillSignal':'9','TasksMax':'16','NoNewPrivileges':'yes'}
if len(rows)!=len(row) or set(row)!=set(keys) or not re.fullmatch('[0-9a-f]{32}',inv) or any(row[k]!=v for k,v in expected.items()) or Path('/proc/self/cgroup').read_text().strip()!='0::'+row['ControlGroup']:raise ValueError('Independent workflow envelope differs')
start=row['ExecMainStartTimestampMonotonic']
if not re.fullmatch('[0-9]{1,19}',start):raise ValueError('Exact workflow origin required')
elapsed=time.monotonic_ns()-int(start)*1000
if not 0<=elapsed<10_000_000_000 or time.time_ns()-elapsed+243_000_000_000>=deadline:raise ValueError('Independent cutoff exceeds original deadline')
def directory(path):
 if not path.is_absolute() or path.resolve(strict=True)!=path:raise ValueError('Canonical private owner namespace required')
 for parent in[path,*path.parents]:
  st=parent.lstat()
  if not stat.S_ISDIR(st.st_mode) or st.st_uid not in(0,uid) or st.st_mode&0o022:raise ValueError('Owner ancestor authority differs')
 if path.stat().st_uid!=uid or stat.S_IMODE(path.stat().st_mode)!=0o700:raise ValueError('Private owned directory required')
def read(path,sha,limit=65536):
 directory(path.parent)
 if not re.fullmatch('[0-9a-f]{64}',sha):raise ValueError('Exact input hash required')
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb')as f:
  st=os.fstat(f.fileno());raw=f.read(limit+1);after=os.fstat(f.fileno())
  if not stat.S_ISREG(st.st_mode) or st.st_uid!=uid or st.st_nlink!=1 or stat.S_IMODE(st.st_mode)!=0o600 or not 0<len(raw)<=limit or len(raw)!=st.st_size or(st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns)or hashlib.sha256(raw).hexdigest()!=sha:raise ValueError('Protected pinned input changed')
 return raw
def sync(path):
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(fd)
 finally:os.close(fd)
def write(path,raw):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb')as f:f.write(raw);f.flush();os.fsync(f.fileno())
 sync(path.parent)
 return {'path':str(path),'sha256':hashlib.sha256(raw).hexdigest()}
def encode(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()+b'\n'
def decode(raw):
 def pairs(rows):
  result={}
  for k,v in rows:
   if k in result:raise ValueError('Duplicate workflow field')
   result[k]=v
  return result
 return json.loads(raw,object_pairs_hook=pairs)
pins=decode(base64.b64decode(pins64,validate=True));source=Path(source_arg);directory(source);directory(source/'guest')
names=__SOURCE_NAMES__
if set(pins)!=set(names):raise ValueError('Exact maintained source closure required')
def sources():
 # Refuse shadow imports, symlink files or extra directories before loading.
 for folder,expected_names in[(source,{n for n in names if '/'not in n}|{'guest'}),(source/'guest',{n.split('/')[1]for n in names if '/'in n})]:
  with os.scandir(folder)as entries:
   found=[]
   for entry in entries:
    found.append(entry.name)
    if len(found)>16:raise ValueError('Source namespace bound')
  if set(found)!=expected_names:raise ValueError('Unpinned source or shadow import')
 return {n:read(source/n,pins[n],262144)for n in names}
initial=sources();profile_raw=read(Path(profile_path),profile_sha);profile=decode(profile_raw)
if set(profile)!=set(__PROFILE_FIELDS__) or profile['ownerBootId']!=boot or profile['vmAttempt']!=vm:raise ValueError('Original local workflow profile differs')
root=Path(root_arg);directory(root);current()
raw=sys.stdin.buffer.read(16385)
if not 0<len(raw)<=16384 or hashlib.sha256(raw).hexdigest()!=wanted:raise ValueError('Bounded public workflow input required')
wire=decode(raw)
if set(wire)!={'schema','clock','endpointBase64','recipientFiles','attempt','instance','vmAttempt','createdUtcNs','deadlineUtcNs'} or wire['schema']!='owned-rpc-guest-workflow-submit/1':raise ValueError('Exact public workflow submission required')
if (wire['attempt'],wire['instance'],wire['vmAttempt'],wire['createdUtcNs'],wire['deadlineUtcNs'])!=(attempt,instance,vm,created,deadline):raise ValueError('Another original startup window')
files=wire['recipientFiles']
if set(files)!={'serverContract','serverReady'}:raise ValueError('Exact prior imported files required')
for name,filename in[('serverContract','server-contract.json'),('serverReady','server-ready.json')]:
 if set(files[name])!={'path','sha256'} or files[name]['path']!=str(root/attempt/filename):raise ValueError('Exact completed import path required')
 read(Path(files[name]['path']),files[name]['sha256'])
server=decode(read(Path(files['serverContract']['path']),files['serverContract']['sha256']))
if (server['attempt'],server['instance'],server['createdUtcNs'],server['deadlineUtcNs'],server['startupClock'])!=(attempt,instance,created,deadline,wire['clock']):raise ValueError('Imported server changed original identity/window')
endpoint_raw=base64.b64decode(wire['endpointBase64'],validate=True);endpoint=decode(endpoint_raw)
if not 0<len(endpoint_raw)<=8192 or endpoint['clock']!=wire['clock'] or endpoint['pending']is not False:raise ValueError('Original completed endpoint required')
current();folder=root/(attempt+'-workflow-submit');folder.mkdir(mode=0o700);sync(root)
write(folder/'intent.json',encode({'wireSha256':wanted,'profileSha256':profile_sha,'sourcePins':pins,'unitInvocation':inv,'deadlineUtcNs':deadline,'outcome':'consumed-no-automatic-retry'}))
endpoint_binding=write(folder/'endpoint.json',endpoint_raw)
config={k:profile[k]for k in __PROFILE_FIELDS__ if k!='guestIdentityFile'}
config.update(files);config['endpointReceipt']=endpoint_binding;config['target']={**endpoint['endpoint'],'user':'rpcadmin','identityFile':profile['guestIdentityFile']}
write(folder/'request.json',encode(config));current()
# Only reviewed, protected code is loaded. Never accept code bytes in stdin.
spec=importlib.util.spec_from_file_location('workflow_entry',source/'run_guest_workflow.py');entry=importlib.util.module_from_spec(spec);spec.loader.exec_module(entry)
if sources()!=initial or read(Path(profile_path),profile_sha)!=profile_raw:raise ValueError('Source/profile changed before workflow entry')
current();result_binding=entry.run(config);current()
workflow=decode(read(Path(result_binding['path']),result_binding['sha256']))
receipt={'schema':'owned-rpc-guest-workflow-delivery/1','attempt':attempt,'instance':instance,'vmAttempt':vm,'createdUtcNs':created,'deadlineUtcNs':deadline,'wireSha256':wanted,'profileSha256':profile_sha,'sourcePinsSha256':hashlib.sha256(encode(pins)).hexdigest(),'recipientUid':uid,'recipientBootId':boot,'unitInvocation':inv,'atUtcNs':time.time_ns(),'result':result_binding,'workflow':workflow,'rpcReady':False,'remoteDeathProven':False,'reservationMayRelease':False}
write(folder/'receipt.json',encode(receipt));current();print(json.dumps(receipt),flush=True)
'''.replace('__SOURCE_NAMES__', repr(SOURCE_NAMES)).replace('__PROFILE_FIELDS__', repr(PROFILE_FIELDS))


def package(config, local=False):
    fields = {'clock', 'serverContract', 'serverReady', 'exportReceipt', 'endpointReceipt', 'target',
              'knownHosts', 'hostAlias', 'sshSha256', 'recipientRoot', 'recipientUid', 'recipientBootId',
              'sourceRoot', 'sourcePins', 'profile'}
    if local:
        fields -= {'target','knownHosts','hostAlias','sshSha256'}
    if set(config) != fields:
        raise ValueError('Exact workflow sender configuration required')
    original, files, export_wire = t.package(config)
    for key in ('recipientRoot', 'sourceRoot'):
        t.path_text(config[key])
    p.boot(config['recipientBootId'])
    if type(config['recipientUid']) is not int or not 0 <= config['recipientUid'] <= 2147483647:
        raise ValueError('Admitted recipient UID required')
    if set(config['sourcePins']) != set(SOURCE_NAMES) or set(config['profile']) != {'path', 'sha256'}:
        raise ValueError('Exact protected source/profile pins required')
    t.path_text(config['profile']['path']);p.digest(config['profile']['sha256'])
    for name, sha in config['sourcePins'].items():
        p.digest(sha)
        if p.sha((Path(__file__).parent / name).read_bytes()) != sha:
            raise ValueError('Recipient source must match reviewed maintained workflow')
    imported_raw = c.read_pinned(config['exportReceipt']); imported = p.decode(imported_raw)
    expected = {'schema': 'owned-rpc-export-import/1', 'attempt': original['attempt'], 'instance': original['instance'],
                'wireSha256': p.sha(export_wire), 'createdUtcNs': original['createdUtcNs'], 'deadlineUtcNs': original['deadlineUtcNs'],
                'recipientBootId': config['recipientBootId'], 'recipientUid': config['recipientUid'], 'imported': True,
                'guestSubmitted': False, 'rpcReady': False, 'writersFenced': False}
    if set(imported) != set(expected) | {'unitInvocation', 'atUtcNs', 'files'} or any(imported[k] != v or type(imported[k]) is not type(v) for k,v in expected.items()):
        raise ValueError('Original authenticated import receipt required')
    if (not re.fullmatch('[0-9a-f]{32}', imported['unitInvocation']) or type(imported['atUtcNs']) is not int
            or not original['createdUtcNs'] <= imported['atUtcNs'] <= time.time_ns() < original['deadlineUtcNs']):
        raise ValueError('Original import time/incarnation required')
    bindings = {key: {'path': config['recipientRoot']+'/'+original['attempt']+'/'+name, 'sha256': p.sha(files[key])}
                for key,name in [('serverContract','server-contract.json'),('serverReady','server-ready.json')]}
    if imported['files'] != bindings:
        raise ValueError('Prior import paths/hashes differ')
    root = Path(config['clock']['path']).parent
    if config['endpointReceipt']['path'] != str(root/'windows-endpoint/RESULT.json'):
        raise ValueError('Original owner endpoint result required')
    endpoint_raw = c.read_pinned(config['endpointReceipt']); endpoint = p.decode(endpoint_raw)
    request = p.decode(c.read(root/'windows-endpoint/request.json'))
    if (endpoint['clock'] != config['clock'] or request['clock'] != config['clock']
            or endpoint['startResult'] != request['startResult'] or endpoint['expected'] != e.lineage(request, original)
            or endpoint['response']['path'] != str(root/'windows-endpoint/response.json') or endpoint['pending'] is not False):
        raise ValueError('Original consumed endpoint lineage differs')
    native = p.decode(c.read_pinned(endpoint['response']))
    if endpoint['endpoint'] != {'host': native['ipv4'], 'port': native['port']}:
        raise ValueError('Endpoint changed from original authenticated response')
    # Native two-second freshness was checked when the original result was
    # published. This transports that prior observation, not a new freshness claim.
    wire = {'schema':'owned-rpc-guest-workflow-submit/1','clock':config['clock'], 'endpointBase64':base64.b64encode(endpoint_raw).decode(),
            'recipientFiles':bindings, **{k:original[k] for k in ('attempt','instance','vmAttempt','createdUtcNs','deadlineUtcNs')}}
    raw = c.encode(wire)
    if len(raw) > 16384:
        raise ValueError('Public workflow request bound')
    return original, raw


def remote_command(original, config, raw):
    props = ['Type=exec','MemoryMax=256M','MemorySwapMax=0','CPUQuota=100%','TasksMax=16','LimitCORE=0',
             'RuntimeMaxSec=240','TimeoutStopSec=1','KillMode=control-group','SendSIGKILL=yes',
             'FinalKillSignal=SIGKILL','Restart=no','UMask=0077','NoNewPrivileges=yes']
    return ['/usr/bin/systemd-run','--user','--quiet','--wait','--pipe',
            '--unit=enclave-rpc-guest-workflow-'+original['attempt']+'.service', *['--property='+v for v in props],
            '/usr/bin/python3','-I','-c',BOOTSTRAP,original['attempt'],original['instance'],original['vmAttempt'],
            str(original['createdUtcNs']),str(original['deadlineUtcNs']),p.sha(raw),config['recipientRoot'],
            str(config['recipientUid']),config['recipientBootId'],config['sourceRoot'],
            base64.b64encode(c.encode(config['sourcePins'])).decode(),config['profile']['path'],config['profile']['sha256']]


def send(config):
    return _send(config, False)


def send_local(config):
    return _send(t.local_config(config), True)


def _send(config, local):
    config = p.decode(c.encode(config))
    original, raw = package(config, local)
    known = None
    if not local:
        p.digest(config['sshSha256'])
        if p.sha(Path('/usr/bin/ssh').read_bytes()) != config['sshSha256']:
            raise ValueError('Owner SSH client changed')
        target = d.endpoint(config['target']);known = c.read_pinned(config['knownHosts'])
        alias = config['hostAlias'];d.ssh_options(Path('/unused'), alias)
        parts = known.decode('ascii').strip().split()
        if len(parts) != 3 or parts[:2] != [alias,'ssh-ed25519'] or known.count(b'\n') > 1:
            raise ValueError('One trusted recipient host key required')
        key = base64.b64decode(parts[2],validate=True)
        if len(key) != 51 or key[:19] != b'\0\0\0\x0bssh-ed25519\0\0\0\x20':
            raise ValueError('Recipient host key encoding differs')
    parent = c.directory(Path(config['clock']['path']).parent);root = parent/'guest-workflow-submit'
    if c.remaining(config['clock']) < 255:
        raise TimeoutError('Insufficient original window for independent guest workflow')
    root.mkdir(mode=0o700);c.sync_directory(parent)
    if not local:c.write_new(root/'known-hosts', known)
    c.write_new(root/'intent.json', c.encode({'wireSha256':p.sha(raw),'configurationSha256':p.sha(c.encode(config)),
        'bootstrapSha256':p.sha(BOOTSTRAP.encode()),'deadlineUtcNs':original['deadlineUtcNs'],'outcome':'consumed-no-automatic-retry','transport':'local-user-unit' if local else 'pinned-ssh'}))
    if package(config, local) != (original,raw) or (not local and c.read_pinned(config['knownHosts']) != known):
        raise ValueError('Workflow submission inputs changed')
    started = time.time_ns()
    command = remote_command(original,config,raw)
    argv = command if local else d.ssh_options(root/'known-hosts',alias)+target+[shlex.join(command)]
    reply = d.exchange(argv,raw,min(250,c.remaining(config['clock'])))
    c.write_new(root/'response.json',reply);c.validate(config['clock']);r = p.decode(reply)
    expected = {'schema':'owned-rpc-guest-workflow-delivery/1','attempt':original['attempt'],'instance':original['instance'],
        'vmAttempt':original['vmAttempt'],'createdUtcNs':original['createdUtcNs'],'deadlineUtcNs':original['deadlineUtcNs'],
        'wireSha256':p.sha(raw),'profileSha256':config['profile']['sha256'],'sourcePinsSha256':p.sha(c.encode(config['sourcePins'])),
        'recipientUid':config['recipientUid'],'recipientBootId':config['recipientBootId'],'rpcReady':False,
        'remoteDeathProven':False,'reservationMayRelease':False}
    if set(r) != set(expected)|{'unitInvocation','atUtcNs','result','workflow'} or any(r[k] != v or type(r[k]) is not type(v) for k,v in expected.items()):
        raise ValueError('Workflow recipient result differs')
    if not re.fullmatch('[0-9a-f]{32}',r['unitInvocation']) or type(r['atUtcNs']) is not int or not started <= r['atUtcNs'] <= time.time_ns() < original['deadlineUtcNs']:
        raise ValueError('Fresh workflow receipt required')
    workflow = r['workflow']
    fixed = {'schema':'owned-rpc-guest-workflow/1','attempt':original['attempt'],'instance':original['instance'],
        'ownerBootId':config['recipientBootId'],'createdUtcNs':original['createdUtcNs'],'deadlineUtcNs':original['deadlineUtcNs'],
        'clientProcessesObserved':True,'rpcReady':False,'adopted':False,'providerSettlementProven':False,
        'writersFenced':False,'remoteDeathProven':False,'reservationMayRelease':False}
    if set(workflow) != set(fixed)|{'guestBootId','endpointReceipt','receipts'} or any(workflow[k] != v or type(workflow[k]) is not type(v) for k,v in fixed.items()):
        raise ValueError('Workflow completion binding or claims differ')
    p.boot(workflow['guestBootId'])
    endpoint = {'path':config['recipientRoot']+'/'+original['attempt']+'-workflow-submit/endpoint.json',
                'sha256':config['endpointReceipt']['sha256']}
    if workflow['endpointReceipt'] != endpoint or set(workflow['receipts']) != {'guest-observe','attachment','delivery','launch','activation-observe','prepare-l1','runtime-l1','prepare-base','runtime-base'}:
        raise ValueError('Exact composed workflow receipts required')
    for binding in [r['result'],*workflow['receipts'].values()]:
        if set(binding) != {'path','sha256'}:raise ValueError('Exact public result binding required')
        t.path_text(binding['path']);p.digest(binding['sha256'])
    if r['result']['sha256'] != p.sha(c.encode(workflow)) or package(config, local) != (original,raw):
        raise ValueError('Workflow result or original inputs changed')
    return c.write_new(root/'RESULT.json',c.encode(r))


if __name__ == '__main__':
    import sys
    os.umask(0o077)
    print(json.dumps(send(p.decode(c.read(sys.argv[1])))))

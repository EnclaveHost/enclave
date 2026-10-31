#!/usr/bin/env python3
"""One-shot guest storage activation owner; no chain start or automatic adoption.

An admitted external owner still owns the original VM deadline and reservations.
The local watchdog and BindsTo/After relationships stop attachment units if this
owner stalls or exits. They do not prove device or provider-level writer fencing.
"""
import base64,hashlib,importlib.util,json,os,re,socket,stat,subprocess,sys,time
from pathlib import Path

HERE=Path(__file__).resolve().parent

def load(name):
    path=HERE/(name+'.py')
    if name=='storage_protocol' and not path.exists():path=HERE.parent/(name+'.py')
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
protocol=load('storage_protocol');identity=load('identity');attachment=load('attach_storage')
UNIT='enclave-rpc-storage-activation.service'
ROLES=('l1','base')
CONFIG=Path('/etc/enclave-rpc');STATE=Path('/var/lib/enclave-rpc-activation')
REQUEST=CONFIG/'activation-request.json'


def protected_bytes(path,mode=0o600,limit=65536):
    path=Path(path)
    if not path.is_absolute() or path.resolve(strict=True)!=path:raise ValueError('Canonical root-owned input required')
    for parent in path.parents:
        st=parent.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid!=0 or st.st_mode&0o022:raise ValueError('Unprotected input ancestor')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as f:
        st=os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_nlink!=1 or stat.S_IMODE(st.st_mode)!=mode or st.st_size>limit:
            raise ValueError('Bounded root-owned input required')
        raw=f.read(limit+1)
    if len(raw)>limit:raise ValueError('Input grew')
    return raw


def write_new(path,value):
    raw=value if isinstance(value,bytes) else json.dumps(value,sort_keys=True).encode()+b'\n'
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
    fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(fd)
    finally:os.close(fd)


def required_pins():
    scripts=['activate_storage.py','attach_storage.py','storage_protocol.py','identity.py']
    units=[UNIT]+['enclave-rpc-attach-'+role+'.service' for role in ROLES]
    return ({'/opt/enclave-rpc/'+name: (0o644 if name=='storage_protocol.py' else 0o755) for name in scripts}
            | {'/etc/systemd/system/'+name:0o644 for name in units})


def validate_request(request):
    if os.geteuid()!=0:raise ValueError('Guest root required')
    if set(request)!={'bundle','resultSha256','runtimePins'} or set(request['runtimePins'])!=set(required_pins()):
        raise ValueError('Exact activation request and runtime closure required')
    for path,pin in request['runtimePins'].items():
        protocol.digest(pin)
        if protocol.sha(protected_bytes(path,required_pins()[path],262144))!=pin:raise ValueError('Activation source/unit changed')
    bundle=Path(request['bundle'])
    if bundle.parent!=Path('/run/enclave-rpc-import') or not re.fullmatch('[0-9a-f]{32}',bundle.name):raise ValueError('Fixed import namespace required')
    protocol.digest(request['resultSha256'])
    return bundle


def validate_bundle(request,files):
    if set(files)!={'attachment.json','server-ready.json','RESULT.json'}:raise ValueError('Exact public bundle files required')
    result_raw=files['RESULT.json']
    if protocol.sha(result_raw)!=request['resultSha256']:raise ValueError('Owner bundle receipt changed')
    raw={name:files[name] for name in ['attachment.json','server-ready.json']}
    result=protocol.decode(result_raw)
    expected={'schema','attempt','instance','guestBootId','createdUtcNs','deadlineUtcNs','files','contractInputs','storageAttached','rpcReady','writersFenced'}
    if set(result)!=expected or result['schema']!='owned-rpc-attachment-bundle/1' or set(result['files'])!={'attachment.json','server-ready.json'}:
        raise ValueError('Exact owner bundle receipt required')
    if any(result[k] is not False for k in ['storageAttached','rpcReady','writersFenced']):raise ValueError('Bundle makes premature activation claim')
    if any(protocol.sha(raw[name])!=pin for name,pin in result['files'].items()):raise ValueError('Owner bundle member changed')
    contract=protocol.decode(raw['attachment.json']);boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    protocol.validate_attachment(contract,time.time_ns(),boot)
    protocol.validate_ready(protocol.decode(raw['server-ready.json']),contract,time.time_ns())
    if contract['serverReadySha256']!=protocol.sha(raw['server-ready.json']):raise ValueError('Server receipt differs')
    if Path(request['bundle']).name!=contract['attempt']:raise ValueError('Imported attempt differs')
    for left,right in [('attempt','attempt'),('instance','instance'),('guestBootId','bootId'),('createdUtcNs','createdUtcNs'),('deadlineUtcNs','deadlineUtcNs')]:
        if result[left]!=contract[right]:raise ValueError('Owner manifest and guest contract differ')
    if set(result['contractInputs'])!={'serverContract','serverReady','credentialReceipt'}:raise ValueError('Owner input provenance incomplete')
    for value in result['contractInputs'].values():protocol.digest(value)
    if result['contractInputs']['serverContract']!=contract['serverContractSha256'] or result['contractInputs']['serverReady']!=contract['serverReadySha256']:
        raise ValueError('Owner provenance differs')
    local=protocol.decode(protected_bytes(CONFIG/'identity.json',0o644));identity.check_context(local)
    if local['instance']!=contract['instance']:raise ValueError('Foreign guest instance')
    for role,row in contract['roles'].items():
        path=CONFIG/'storage'/contract['attempt']/role
        for parent in [path,path.parent,path.parent.parent]:
            st=parent.lstat()
            if not stat.S_ISDIR(st.st_mode) or st.st_uid!=0 or stat.S_IMODE(st.st_mode)!=0o700:raise ValueError('Private seeded credentials required')
        for name,key in [('ca-cert.pem','caSha256'),('client-cert.pem','certificateSha256')]:
            if protocol.sha(protected_bytes(path/name))!=row[key]:raise ValueError('Seeded credential differs')
        protected_bytes(path/'client-key.pem')
    return contract


def private_directory(path):
    if path.resolve(strict=True)!=path:raise ValueError('Canonical private directory required')
    for parent in [path,*path.parents]:
        st=parent.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid!=0 or st.st_mode&0o022:raise ValueError('Protected directory authority required')
    if stat.S_IMODE(path.stat().st_mode)!=0o700:raise ValueError('Private root directory required')


def consume(parent,attempt):
    private_directory(parent);state=parent/attempt;state.mkdir(mode=0o700)
    fd=os.open(parent,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(fd)
    finally:os.close(fd)
    return state


def stage(request_raw,invocation):
    request=protocol.decode(request_raw);bundle=validate_request(request)
    if not re.fullmatch('[0-9a-f]{32}',invocation):raise ValueError('Exact activation invocation required')
    private_directory(bundle);private_directory(bundle.parent)
    files={name:protected_bytes(bundle/name) for name in ['attachment.json','server-ready.json','RESULT.json']}
    contract=validate_bundle(request,files);boot=contract['bootId']
    # Do not overwrite a previous or partial installation. Consume before writes.
    state=consume(STATE,contract['attempt'])
    write_new(state/'intent.json',{'attempt':contract['attempt'],'bootId':boot,'requestSha256':protocol.sha(request_raw),'unitInvocation':invocation,'deadlineUtcNs':contract['deadlineUtcNs']})
    for name in ['attachment.json','server-ready.json']:write_new(CONFIG/name,files[name])
    protocol.validate_attachment(contract,time.time_ns(),boot)
    return contract,state,protocol.sha(files['attachment.json'])


def receive(raw,attempt,wire_sha,invocation):
    """Install a public owner bundle once; never start a service or extend time."""
    if not re.fullmatch('[0-9a-f]{32}',attempt) or not re.fullmatch('[0-9a-f]{32}',invocation):raise ValueError('Exact delivery incarnation required')
    protocol.digest(wire_sha)
    if protocol.sha(raw)!=wire_sha:raise ValueError('Delivery bytes changed')
    wire=protocol.decode(raw)
    if set(wire)!={'schema','request','files'} or wire['schema']!='owned-rpc-activation-delivery/1':raise ValueError('Exact delivery schema required')
    request=wire['request'];bundle=validate_request(request)
    if bundle.name!=attempt:raise ValueError('Delivery attempt differs')
    files={name:base64.b64decode(value,validate=True) for name,value in wire['files'].items()}
    contract=validate_bundle(request,files);private_directory(bundle.parent)
    state=consume(Path('/var/lib/enclave-rpc-delivery'),attempt)
    write_new(state/'intent.json',{'attempt':attempt,'bootId':contract['bootId'],'wireSha256':wire_sha,'unitInvocation':invocation,'deadlineUtcNs':contract['deadlineUtcNs']})
    consume(bundle.parent,attempt)
    for name,data in files.items():write_new(bundle/name,data)
    request_raw=json.dumps(request,sort_keys=True).encode()+b'\n'
    # Publication comes last; failure leaves a consumed, non-retryable attempt.
    protocol.validate_attachment(contract,time.time_ns(),contract['bootId'])
    write_new(REQUEST,request_raw)
    for name,data in files.items():
        if protected_bytes(bundle/name)!=data:raise ValueError('Installed bundle changed')
    if protected_bytes(REQUEST)!=request_raw:raise ValueError('Installed request changed')
    validate_request(request);validate_bundle(request,files)
    result={'schema':'owned-rpc-activation-delivery-receipt/1','attempt':attempt,'bootId':contract['bootId'],
        'wireSha256':wire_sha,'requestSha256':protocol.sha(request_raw),'unitInvocation':invocation,'atUtcNs':time.time_ns(),
        'installed':True,'activationStarted':False,'rpcReady':False}
    write_new(state/'receipt.json',result)
    protocol.validate_attachment(contract,time.time_ns(),contract['bootId'])
    return result


def receive_main(attempt,wire_sha):
    os.umask(0o077)
    unit='enclave-rpc-delivery-'+attempt+'.service';row=show(unit)
    if (row['Id']!=unit or row['MainPID']!=str(os.getpid()) or row['InvocationID']!=os.environ.get('INVOCATION_ID')
        or row['Type']!='exec' or row['RuntimeMaxUSec']!='5s' or row['TimeoutStopUSec']!='1s'
        or row['MemoryMax']!=str(64<<20) or row['MemorySwapMax']!='0' or row['CPUQuotaPerSecUSec']!='1s'
        or row['KillMode']!='control-group' or row['Restart']!='no' or row['SendSIGKILL']!='yes' or row['FinalKillSignal']!='9'
        or Path('/proc/self/cgroup').read_text().strip()!='0::'+row['ControlGroup']):raise ValueError('Independent delivery envelope mismatch')
    raw=sys.stdin.buffer.read(65537)
    result=receive(raw,attempt,wire_sha,os.environ['INVOCATION_ID'])
    print(json.dumps(result),flush=True)


def command(args):
    r=subprocess.run(['/usr/bin/systemctl',*args],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=.75)
    if r.returncode or len(r.stdout)+len(r.stderr)>16384:raise RuntimeError('Bounded systemd operation failed')
    return r.stdout.decode('utf-8','strict')


def show(unit):
    props='RuntimeMaxUSec,Id,LoadState,ActiveState,SubState,MainPID,ControlPID,Job,InvocationID,ControlGroup,FragmentPath,DropInPaths,NeedDaemonReload,BindsTo,After,Type,NotifyAccess,WatchdogUSec,WatchdogSignal,WatchdogTimestampMonotonic,KillMode,Restart,MemoryMax,MemorySwapMax,CPUQuotaPerSecUSec,TimeoutStartUSec,TimeoutStopUSec,SendSIGKILL,FinalKillSignal'
    return dict(line.split('=',1) for line in command(['show',unit,'--property='+props]).splitlines() if '=' in line)


def validate_unit(row,unit,owner=False):
    if (row['Id']!=unit or row['LoadState']!='loaded' or row['FragmentPath']!='/etc/systemd/system/'+unit or row['DropInPaths'] or row['NeedDaemonReload']!='no'
        or row['Restart']!='no' or row['KillMode']!='control-group' or row['MemoryMax']!=str(128<<20) or row['MemorySwapMax']!='0' or row['CPUQuotaPerSecUSec']!='1s'):
        raise ValueError('Exact guest unit definition required')
    if owner:
        if (row['MainPID']!=str(os.getpid()) or row['InvocationID']!=os.environ.get('INVOCATION_ID') or row['Type']!='notify' or row['NotifyAccess']!='main'
            or row['WatchdogUSec']!='2s' or row['WatchdogSignal']!='9' or row['TimeoutStartUSec']!='3s' or row['TimeoutStopUSec']!='1s' or row['SendSIGKILL']!='yes' or row['FinalKillSignal']!='9'
            or Path('/proc/self/cgroup').read_text().strip()!='0::'+row['ControlGroup']):raise ValueError('Independent activation watchdog mismatch')
    elif UNIT not in row['BindsTo'].split() or UNIT not in row['After'].split():raise ValueError('Attachment lacks owner lifetime dependency')


def notify(message):
    address=os.environ['NOTIFY_SOCKET'];address='\0'+address[1:] if address.startswith('@') else address
    with socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM) as sock:sock.sendto(message.encode(),address)


def current_ready(role,contract,contract_sha,props):
    unit='enclave-rpc-attach-'+role+'.service';validate_unit(props,unit)
    block=Path('/sys/block')/attachment.ROLES[role]['device']
    if props['ActiveState']!='active' or int(props['MainPID'])<=0 or not re.fullmatch('[0-9a-f]{32}',props['InvocationID']):raise ValueError('Attachment not active')
    raw=protected_bytes(Path('/run/enclave-rpc-attachment')/(contract['attempt']+'-'+role)/'ready.json');r=protocol.decode(raw)
    expected={'attempt':contract['attempt'],'bootId':contract['bootId'],'contractSha256':contract_sha,'uuid':contract['roles'][role]['uuid'],'bytes':protocol.BYTES,'unitInvocation':props['InvocationID'],'device':(block/'dev').read_text().strip(),'mountReady':True,'rpcReady':False}
    if set(r)!=set(expected)|{'ownerPid','ownerStart'} or any(r.get(k)!=v or type(r.get(k)) is not type(v) for k,v in expected.items()):raise ValueError('Attachment receipt binding differs')
    if type(r.get('ownerPid')) is not int or r['ownerPid']<=0 or not isinstance(r.get('ownerStart'),str) or not re.fullmatch('[0-9]+',r['ownerStart']):raise ValueError('Exact NBD owner required')
    if int((block/'pid').read_text())!=r['ownerPid'] or int((block/'size').read_text())*512!=protocol.BYTES:raise ValueError('Kernel attachment differs')
    pid=Path('/proc')/str(r['ownerPid']);text=(pid/'stat').read_text();start=text[text.rfind(')')+2:].split()[19]
    if start!=r['ownerStart'] or (pid/'cgroup').read_text().strip()!='0::'+props['ControlGroup']:raise ValueError('NBD owner replaced')
    return {'unit':unit,'invocation':props['InvocationID'],'readySha256':protocol.sha(raw),'ownerPid':r['ownerPid'],'ownerStart':start}


def adoption(path,c,request_sha,ready_sha,now):
    if not path.exists():return None
    raw=protected_bytes(path);a=protocol.decode(raw)
    expected={'attempt':c['attempt'],'bootId':c['bootId'],'activationRequestSha256':request_sha,'activationReadySha256':ready_sha}
    if set(a)!=set(expected)|{'adoptedUtcNs'} or any(a[k]!=v for k,v in expected.items()):raise ValueError('Activation adoption binding differs')
    at=a['adoptedUtcNs']
    if type(at) is not int or not c['createdUtcNs']<=at<=now<c['deadlineUtcNs']:raise ValueError('Adoption not observed within original deadline')
    return protocol.sha(raw)


def main():
    os.umask(0o077);validate_unit(show(UNIT),UNIT,True)
    request=protected_bytes(REQUEST);request_sha=protocol.sha(request);c,state,contract_sha=stage(request,os.environ['INVOCATION_ID'])
    wall=time.time_ns();mono=time.monotonic_ns();deadline=mono+(c['deadlineUtcNs']-wall);adopted=None
    def tick():
        if abs((time.time_ns()-wall)-(time.monotonic_ns()-mono))>2_000_000_000:raise RuntimeError('Guest clock changed')
        if time.monotonic_ns()>=deadline and adopted is None:raise TimeoutError('Original activation deadline')
        if protocol.sha(protected_bytes(REQUEST))!=request_sha:raise ValueError('Activation request changed')
        if protocol.sha(protected_bytes(CONFIG/'attachment.json'))!=contract_sha:raise ValueError('Installed contract changed')
        notify('WATCHDOG=1')
    # Verify both inactive dependents before opening the service's READY gate.
    for role in ROLES:
        unit='enclave-rpc-attach-'+role+'.service';row=show(unit);validate_unit(row,unit)
        if row['ActiveState'] not in ('inactive','failed') or row['MainPID']!='0' or row['ControlPID']!='0' or row['Job'] not in ('','0'):
            raise ValueError('Attachment already active or queued')
    notify('READY=1\nSTATUS=Storage activation owner armed; storage is not ready\nWATCHDOG=1')
    until=time.monotonic()+.5
    while True:
        owner=show(UNIT);validate_unit(owner,UNIT,True)
        if owner['ActiveState']=='active' and int(owner['WatchdogTimestampMonotonic'])>0:break
        if time.monotonic()>=until:raise RuntimeError('Watchdog acknowledgement absent')
        time.sleep(.01)
    rows={}
    for role in ROLES:
        tick();unit='enclave-rpc-attach-'+role+'.service'
        # Durable intent precedes the sole submission. Unknown response is never retried.
        write_new(state/(role+'-intent.json'),{'unit':unit,'atUtcNs':time.time_ns(),'activationInvocation':os.environ['INVOCATION_ID']})
        command(['--no-block','--job-mode=fail','start',unit]);until=time.monotonic()+45
        while True:
            tick();props=show(unit);validate_unit(props,unit)
            if props['ActiveState']=='active':rows[role]=current_ready(role,c,contract_sha,props);break
            if props['ActiveState']=='failed' or time.monotonic()>=until:raise RuntimeError('Attachment failed or readiness timed out')
            time.sleep(.05)
    value={'attempt':c['attempt'],'bootId':c['bootId'],'requestSha256':request_sha,'contractSha256':contract_sha,'roles':rows,'atUtcNs':time.time_ns(),'rpcReady':False,'writersFenced':False}
    tick();write_new(state/'ready.json',value);ready_sha=protocol.sha(protected_bytes(state/'ready.json'))
    while True:
        tick()
        if adopted is None:adopted=adoption(state/'adoption.json',c,request_sha,ready_sha,time.time_ns())
        elif protocol.sha(protected_bytes(state/'adoption.json'))!=adopted:raise ValueError('Activation adoption withdrawn or changed')
        for role in ROLES:
            tick()
            if current_ready(role,c,contract_sha,show('enclave-rpc-attach-'+role+'.service'))!=rows[role]:raise ValueError('Attachment changed after readiness')
        time.sleep(.1)


if __name__=='__main__':
    if len(sys.argv)==1:main()
    elif len(sys.argv)==4 and sys.argv[1]=='receive':receive_main(sys.argv[2],sys.argv[3])
    else:raise ValueError('Explicit activation or one-shot delivery only')

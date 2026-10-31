#!/usr/bin/env python3
"""Owner-requested, one-shot mount/client submission; never RPC adoption.

Run separately for l1 and base in the exact bounded transient root unit. The
original storage/VM deadline remains authoritative. Base's existing coverage,
history, proof and owned-L1 checks execute in its unchanged client wrapper.
"""
import importlib.util,json,os,re,sys,time
from pathlib import Path

spec=importlib.util.spec_from_file_location('activation',Path(__file__).with_name('activate_storage.py'))
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
p=a.protocol
MOUNTS={'l1':r'srv-enclave\x2dl1\x2dpair.mount','base':r'srv-enclave\x2dbase\x2dholder.mount'}
WHERE={'l1':'/srv/enclave-l1-pair','base':'/srv/enclave-base-holder'}
SIDES={'l1':('el','cl'),'base':('base',)}

def required_pins():
    pins={'/opt/enclave-rpc/start_runtime.py':0o755,
          '/opt/enclave-rpc/chain_service.py':0o755,
          '/opt/enclave-rpc/manifest.json':0o644,
          '/etc/enclave-rpc/chain.json':0o644,
          '/etc/enclave-rpc-vm/disks.json':0o644}
    for unit in [*MOUNTS.values(),'enclave-rpc-clients.slice',*['enclave-rpc-'+s+'.service' for s in ('el','cl','base')]]:
        pins['/etc/systemd/system/'+unit]=0o644
    for side in ('el','cl','base'):pins['/etc/systemd/system/enclave-rpc-'+side+'.service.d/identity.conf']=0o644
    return pins

def process(row):
    if row['ActiveState']!='active' or int(row['MainPID'])<=0 or not re.fullmatch('[0-9a-f]{32}',row['InvocationID']):
        raise ValueError('Exact active process required')
    proc=Path('/proc')/row['MainPID'];text=(proc/'stat').read_text()
    if (proc/'cgroup').read_text().strip()!='0::'+row['ControlGroup']:raise ValueError('Process cgroup differs')
    return {'unit':row['Id'],'invocation':row['InvocationID'],'pid':int(row['MainPID']),
            'start':text[text.rfind(')')+2:].split()[19],'cgroup':row['ControlGroup']}

def show(unit):
    more='What,Where,Options,User,Group,Slice,PrivateMounts'
    row=a.show(unit)
    row.update(dict(x.split('=',1)for x in a.command(['show',unit,'--property='+more]).splitlines()if '=' in x))
    return row

def envelope(phase):
    unit='enclave-rpc-runtime-'+phase+'.service';row=show(unit)
    if (os.geteuid()!=0 or row['Id']!=unit or row['LoadState']!='loaded' or row['MainPID']!=str(os.getpid())
        or row['InvocationID']!=os.environ.get('INVOCATION_ID') or row['RuntimeMaxUSec']!='20s'
        or row['TimeoutStopUSec']!='1s' or row['MemoryMax']!=str(64<<20) or row['MemorySwapMax']!='0'
        or row['CPUQuotaPerSecUSec']!='1s' or row['KillMode']!='control-group' or row['Restart']!='no'
        or row['SendSIGKILL']!='yes' or row['FinalKillSignal']!='9'
        or Path('/proc/self/cgroup').read_text().strip()!='0::'+row['ControlGroup']
        or os.readlink('/proc/self/ns/mnt')!=os.readlink('/proc/1/ns/mnt')):
        raise ValueError('Exact independent runtime submission envelope required')

def validate_unit(row,unit,side=None):
    if (row['Id']!=unit or row['LoadState']!='loaded' or row['FragmentPath']!='/etc/systemd/system/'+unit
        or row['NeedDaemonReload']!='no'):raise ValueError('Loaded runtime unit differs')
    if side is None:
        role=next(k for k,v in MOUNTS.items()if v==unit);dependency='enclave-rpc-attach-'+role+'.service'
        if (row['DropInPaths'] or row['What']!='/dev/'+a.attachment.ROLES[role]['device'] or row['Where']!=WHERE[role]
            or row['Type']!='ext4' or set(row['Options'].split(','))!={'rw','nosuid','nodev','noexec'}):raise ValueError('Exact private-COW mount required')
    else:
        role='base' if side=='base' else 'l1';dependency=MOUNTS[role]
        expected_user={'el':'rpcl1el','cl':'rpcl1cl','base':'rpcbase'}[side]
        if (row['DropInPaths']!='/etc/systemd/system/'+unit+'.d/identity.conf' or row['User']!=expected_user
            or row['Group']!=expected_user or row['Type']!='exec' or row['Restart']!='no' or row['KillMode']!='control-group'
            or row['Slice']!='enclave-rpc-clients.slice' or row['MemorySwapMax']!='0'
            or row['MemoryMax']!=str((7 if side=='cl' else 5)<<30)):
            raise ValueError('Exact client identity/budget/lifetime required')
    if dependency not in row['BindsTo'].split() or dependency not in row['After'].split():raise ValueError('Runtime lifetime dependency missing')

def mounted(role):
    rows=[]
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        left,right=line.split(' - ',1);fields=left.split();end=right.split()
        if fields[4]==WHERE[role]:rows.append((fields,end))
    if len(rows)!=1:raise ValueError('Single actual mount required')
    fields,end=rows[0];block=Path('/sys/block')/a.attachment.ROLES[role]['device']
    if (fields[2]!=(block/'dev').read_text().strip() or end[0]!='ext4'
        or not {'rw','nosuid','nodev','noexec'}<=set(fields[5].split(','))):raise ValueError('Actual kernel mount differs')
    return {'id':fields[0],'device':fields[2],'where':fields[4]}

def inactive(row):
    if row['ActiveState'] not in ('inactive','failed') or row['MainPID']!='0' or row['ControlPID']!='0' or row['Job'] not in ('','0'):
        raise ValueError('Unit already active or queued')

def execute(phase,request_raw):
    if phase not in SIDES:raise ValueError('Explicit l1 or base phase required')
    request=p.decode(request_raw)
    if set(request)!={'phase','activationReadySha256','activationRequestSha256','runtimePins'} or request['phase']!=phase:
        raise ValueError('Exact owner runtime request required')
    for key in ('activationReadySha256','activationRequestSha256'):p.digest(request[key])
    if set(request['runtimePins'])!=set(required_pins()):raise ValueError('Complete runtime closure required')
    for path,mode in required_pins().items():
        p.digest(request['runtimePins'][path])
        if p.sha(a.protected_bytes(path,mode,262144))!=request['runtimePins'][path]:raise ValueError('Runtime input changed')
    aggregate=show('enclave-rpc-clients.slice')
    if (aggregate['Id']!='enclave-rpc-clients.slice' or aggregate['LoadState']!='loaded'
        or aggregate['FragmentPath']!='/etc/systemd/system/enclave-rpc-clients.slice'
        or aggregate['DropInPaths'] or aggregate['NeedDaemonReload']!='no'
        or aggregate['MemoryMax']!=str(17<<30) or aggregate['MemorySwapMax']!='0'):
        raise ValueError('Loaded aggregate client budget differs')
    activation_raw=a.protected_bytes(a.REQUEST)
    if p.sha(activation_raw)!=request['activationRequestSha256']:raise ValueError('Activation request differs')
    activation=p.decode(activation_raw);bundle=a.validate_request(activation)
    c=a.validate_bundle(activation,{name:a.protected_bytes(bundle/name)for name in ('attachment.json','server-ready.json','RESULT.json')})
    state=a.STATE/c['attempt'];a.private_directory(state)
    intent=p.decode(a.protected_bytes(state/'intent.json'))
    ready_raw=a.protected_bytes(state/'ready.json');ready=p.decode(ready_raw)
    contract_sha=p.sha(a.protected_bytes(a.CONFIG/'attachment.json'))
    if (p.sha(ready_raw)!=request['activationReadySha256'] or intent['requestSha256']!=request['activationRequestSha256']
        or intent['bootId']!=c['bootId'] or ready['requestSha256']!=intent['requestSha256'] or ready['contractSha256']!=contract_sha
        or ready['attempt']!=c['attempt'] or ready['bootId']!=c['bootId'] or ready['rpcReady'] is not False or ready['writersFenced'] is not False):
        raise ValueError('Activation receipt binding differs')
    wall=time.time_ns();mono=time.monotonic_ns();deadline=mono+c['deadlineUtcNs']-wall
    owner=None
    def check():
        nonlocal owner
        if abs((time.time_ns()-wall)-(time.monotonic_ns()-mono))>2_000_000_000 or time.monotonic_ns()>=deadline:
            raise TimeoutError('Original startup window expired or clock changed')
        if a.protected_bytes(a.REQUEST)!=activation_raw or a.protected_bytes(state/'ready.json')!=ready_raw:
            raise ValueError('Owner activation changed')
        row=show(a.UNIT);current=process(row)
        if row['InvocationID']!=intent['unitInvocation']:raise ValueError('Activation owner replaced')
        if owner is None:owner=current
        elif owner!=current:raise ValueError('Activation process replaced')
        for role in a.ROLES:
            if a.current_ready(role,c,contract_sha,show('enclave-rpc-attach-'+role+'.service'))!=ready['roles'][role]:
                raise ValueError('Attachment changed')
        if time.monotonic_ns()>=deadline:raise TimeoutError('Observation consumed original deadline')
    check()
    if phase=='base':
        prior=p.decode(a.protected_bytes(state/'runtime-l1-started.json'))
        if (prior['phase']!='l1' or prior['attempt']!=c['attempt'] or prior['bootId']!=c['bootId']
            or prior['activationReadySha256']!=request['activationReadySha256'] or prior['owner']!=owner):raise ValueError('Prior L1 phase differs')
        if prior['mount']!=mounted('l1'):raise ValueError('L1 mount replaced')
        for side in SIDES['l1']:
            unit='enclave-rpc-'+side+'.service';row=show(unit);validate_unit(row,unit,side)
            if process(row)!=prior['clients'][side]:raise ValueError('L1 client replaced')
    units=[(MOUNTS[phase],None)]+[('enclave-rpc-'+s+'.service',s)for s in SIDES[phase]]
    for unit,side in units:
        row=show(unit);validate_unit(row,unit,side);inactive(row)
    # Immutable phase consumption precedes every possible submission. Unknown
    # acknowledgements remain consumed; no automatic reset or second call.
    a.write_new(state/('runtime-'+phase+'-intent.json'),{'requestSha256':p.sha(request_raw),'owner':owner,'invocation':os.environ['INVOCATION_ID']})
    clients={};mount=None
    for unit,side in units:
        check();a.write_new(state/('runtime-'+phase+'-'+('mount' if side is None else side)+'-submit.json'),{'unit':unit,'atUtcNs':time.time_ns()})
        if deadline-time.monotonic_ns()<1_000_000_000:raise TimeoutError('Insufficient original time for bounded submission')
        a.command(['--no-block','--job-mode=fail','start',unit])
        until=time.monotonic()+15
        while True:
            check();row=show(unit);validate_unit(row,unit,side)
            if row['ActiveState']=='active':
                if side is None:mount=mounted(phase)
                else:clients[side]=process(row)
                break
            if row['ActiveState']=='failed' or time.monotonic()>=until:raise RuntimeError('Runtime unit failed or did not start')
            time.sleep(.05)
    check()
    for side,binding in clients.items():
        if process(show(binding['unit']))!=binding:raise ValueError('Client exited during startup')
    if mounted(phase)!=mount:raise ValueError('Mount changed during startup')
    result={'phase':phase,'attempt':c['attempt'],'bootId':c['bootId'],'activationReadySha256':request['activationReadySha256'],
            'owner':owner,'mount':mount,'clients':clients,'atUtcNs':time.time_ns(),'rpcReady':False,'writersFenced':False,'adopted':False}
    a.write_new(state/('runtime-'+phase+'-started.json'),result)
    return result

def main(phase):
    os.umask(0o077);envelope(phase)
    request=a.protected_bytes(a.CONFIG/('runtime-start-'+phase+'.json'))
    print(json.dumps(execute(phase,request)),flush=True)

if __name__=='__main__':
    if len(sys.argv)!=2:raise ValueError('Explicit l1 or base phase required')
    main(sys.argv[1])

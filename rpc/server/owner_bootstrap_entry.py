"""Finite independently supervised owner TLS bootstrap, not deployment authority.

No network/key access before exact service, original clock and source checks.
The prepared relay/dispatcher still verifies owner commitments and real chain
permission. Fixed namespace consumes attempts; failures never authorize replay.
"""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time
from types import SimpleNamespace

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('rpc_owner_entry',HERE/'owner_entry.py')
e=importlib.util.module_from_spec(spec);spec.loader.exec_module(e)
c=e.clock_module()


def envelope(original,continuous=False):
    unit='enclave-rpc-owner-bootstrap-'+('stream-' if continuous else '')+original['attempt']+'.service'
    row=e.show(unit)
    expected={'Id':unit,'MainPID':str(os.getpid()),'InvocationID':os.environ.get('INVOCATION_ID',''),
        'Type':'exec','RuntimeMaxUSec':'2min','TimeoutStopUSec':'1s','MemoryMax':str(256<<20),
        'MemorySwapMax':'0','CPUQuotaPerSecUSec':'1s','TasksMax':'32','KillMode':'control-group',
        'Restart':'no','SendSIGKILL':'yes','FinalKillSignal':'9','NoNewPrivileges':'yes','LimitCORE':'0'}
    if continuous:
        e.stream_envelope(row,original);expected['RuntimeMaxUSec']=row['RuntimeMaxUSec']
    if (not re.fullmatch('[0-9a-f]{32}',expected['InvocationID']) or any(row[k]!=v for k,v in expected.items())
            or Path('/proc/self/cgroup').read_text().strip()!='0::'+row['ControlGroup']):
        raise ValueError('Independent owner bootstrap envelope differs')
    start=int(row['ExecMainStartTimestampMonotonic'])*1000
    if not continuous and (not 0<=time.monotonic_ns()-start<5_000_000_000 or start+122_000_000_000>=original['deadlineMonotonicNs']):
        raise ValueError('Owner bootstrap cutoff must fit original window')
    return row


def closure():
    root=HERE.parent.parent
    return ({str(p) for p in HERE.parent.rglob('*.py')}|
        {str(p) for folder in (HERE,root/'relay',root/'isolation/contract') for p in folder.glob('*.mjs')}|
        {'/usr/bin/python3','/usr/bin/node','/usr/bin/systemd-run','/usr/bin/systemctl','/usr/bin/bwrap'})


def verify_pins(pins):
    if set(pins)!=closure():raise ValueError('Complete bootstrap runtime closure required')
    for path,wanted in pins.items():
        c.protocol.digest(wanted)
        with open(path,'rb') as f:
            if hashlib.file_digest(f,'sha256').hexdigest()!=wanted:raise ValueError('Bootstrap source changed')


def load_owner_state():
    spec=importlib.util.spec_from_file_location('rpc_bootstrap_owner_state',HERE/'owner_state.py')
    owner=importlib.util.module_from_spec(spec);spec.loader.exec_module(owner);return owner


def sealed(value):
    fd=os.memfd_create('rpc-owner-bootstrap',os.MFD_CLOEXEC|os.MFD_ALLOW_SEALING)
    raw=c.encode(value);os.write(fd,raw);os.lseek(fd,0,os.SEEK_SET)
    fcntl.fcntl(fd,fcntl.F_ADD_SEALS,fcntl.F_SEAL_SEAL|fcntl.F_SEAL_SHRINK|fcntl.F_SEAL_GROW|fcntl.F_SEAL_WRITE)
    return fd


def main(path):
    os.umask(0o077)
    config=c.protocol.decode(c.read(path))
    continuous=config.get('schema') in ('enclave-rpc-owner-bootstrap-entry/4','enclave-rpc-owner-bootstrap-entry/5')
    preparing=config.get('schema') in ('enclave-rpc-owner-bootstrap-entry/3','enclave-rpc-owner-bootstrap-entry/4')
    enrolled=preparing or config.get('schema') in ('enclave-rpc-owner-bootstrap-entry/2','enclave-rpc-owner-bootstrap-entry/5')
    fields={'schema','clock','listen','pins'}|({'enrollment','bootstrapPolicy'} if enrolled else {'session'})|({'preparation'} if preparing else {'relay'})
    if set(config)!=fields or config['schema'] not in ('enclave-rpc-owner-bootstrap-entry/1','enclave-rpc-owner-bootstrap-entry/2','enclave-rpc-owner-bootstrap-entry/3','enclave-rpc-owner-bootstrap-entry/4','enclave-rpc-owner-bootstrap-entry/5'):
        raise ValueError('Exact owner bootstrap configuration required')
    original=c.validate(config['clock']);unit=envelope(original,continuous);verify_pins(config['pins'])
    if Path('/proc/self/timens_offsets').exists() and any(line.split()[1:]!=['0','0'] for line in Path('/proc/self/timens_offsets').read_text().splitlines()):
        raise ValueError('Unshifted owner monotonic clock required')
    if preparing:
        spec=importlib.util.spec_from_file_location('rpc_prepare_enrollment',HERE/'prepare_owner_enrollment.py')
        preparation=importlib.util.module_from_spec(spec);spec.loader.exec_module(preparation)
        config=preparation.prepare(SimpleNamespace(c=c,e=e,HERE=HERE,envelope=lambda value:envelope(value,continuous),
            verify_pins=verify_pins,load_owner_state=load_owner_state),config,original)
    # Bind session preparation to the same request/attempt as the real issuer.
    relay_raw=c.read_pinned(config['relay']);relay=c.protocol.decode(relay_raw)
    if set(relay)!={'schema','dispatcher'} or relay['schema']!='enclave-rpc-owner-relay/'+('2' if continuous else '1'):raise ValueError('Prepared relay required')
    dispatcher_raw=c.read_pinned(relay['dispatcher']);dispatcher=c.protocol.decode(dispatcher_raw)
    signer=c.protocol.decode(c.read_pinned(dispatcher['entry']))
    if continuous and (dispatcher.get('schema')!='enclave-rpc-owner-dispatch/2' or signer.get('schema')!='enclave-rpc-owner-entry/2'):raise ValueError('Matching original stream dispatcher/signer required')
    if signer['clock']!=config['clock'] or signer['attempt']!=original['attempt']:raise ValueError('Original signer differs')
    request_fd=e.held(dispatcher['request']['path'],4<<20,wanted=dispatcher['request']['sha256'])
    try:prepared=os.read(request_fd,(4<<20)+1)
    finally:os.close(request_fd)
    spec=importlib.util.spec_from_file_location('rpc_dispatch',HERE/'dispatch_owner.py')
    d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)
    value=d.decode_owner_request(prepared);prepared=c.encode(value).strip()
    session=config.get('session')
    if not enrolled and (set(session)!={'request','runtime','clientCertificate','keys','policy'} or session['request']!=value['request']):
        raise ValueError('Attested request differs from issuer request')
    parent=c.directory(Path(config['clock']['path']).parent)
    # Full overlapping owner endpoint256 + existing owner composition1024 +128
    # bootstrap/collector allowance. Pending and higher installed floors retained.
    contract=c.protocol.decode(c.read_pinned(signer['contract']))
    if contract['startupClock']!=config['clock'] or contract['attempt']!=original['attempt']:raise ValueError('Original export differs')
    observer=contract['resourceArgv']
    if len(observer)!=3 or observer[:2]!=['/usr/bin/node',str(HERE/'observe_resources.mjs')]:raise ValueError('Maintained resource authority required')
    for name in observer:
        with open(name,'rb') as f:
            if hashlib.file_digest(f,'sha256').hexdigest()!=contract['sourcePins'][name]:raise ValueError('Resource source changed')
    import subprocess
    result=subprocess.run(observer,capture_output=True,timeout=3,check=True)
    if len(result.stdout)>65536:raise ValueError('Resource bound')
    resource=c.protocol.decode(result.stdout)
    if (resource.get('authenticated') is not True or resource.get('unreadUnits')!=0 or
        any(type(resource.get(k)) is not int or resource[k]<0 for k in ('availableMiB','pendingMiB','floorMiB')) or
        resource['availableMiB']-resource['pendingMiB']-1408<max(27648,contract['floorMiB'],resource['floorMiB'])):
        raise ValueError('Whole bootstrap composition admission refused')
    listen=config['listen']
    if set(listen)!={'host','port','serverName','key','cert'}:raise ValueError('Explicit pinned TLS listener required')
    owner=load_owner_state()
    policy=c.protocol.decode(c.read_pinned(signer['policy']))
    if continuous and policy.get('schema')!='enclave-rpc-storage-owner/2':raise ValueError('Explicit continuous owner policy required')
    enrollment_fields={}
    if enrolled:
        spec=importlib.util.spec_from_file_location('rpc_bootstrap_inputs',HERE/'owner_bootstrap_inputs.py')
        inputs=importlib.util.module_from_spec(spec);spec.loader.exec_module(inputs)
        session,enrollment,delivery=inputs.prepare(c,config,original,value,contract,policy,signer['contract']['sha256'])
        enrollment_fields={'enrollment':enrollment,'delivery':delivery}
    descriptor=owner.inspect(signer['ownerProvision'],contract,policy)
    if policy['runtime']!=session['runtime']:raise ValueError('Owner runtime differs')
    owner_fds=owner.bind(signer['ownerProvision'],contract,policy)
    seeds={name:fd for name,fd,_ in owner_fds}
    os.close(seeds.pop('journal'))
    key=e.held(listen['key']['path'],16384,wanted=listen['key']['sha256'])
    cert=e.held(listen['cert']['path'],16384,wanted=listen['cert']['sha256'])
    # Key bytes remain a local readonly FD; never JSON, command args or stdout.
    normalized={**session,**enrollment_fields,'parent':str(parent),'original':{**{k:original[k] for k in ('attempt','originMonotonicNs','deadlineMonotonicNs')},'boot':original['bootId']},
        'listen':{'host':listen['host'],'port':listen['port'],'serverName':listen['serverName']},'ownerPublicKeys':[descriptor['keys'][role]['publicKey'] for role in ('l1','base')],'relay':config['relay'],'clock':config['clock'],
        'prepared':prepared.decode(),'pins':config['pins'],'ownerProtocol':2 if continuous else 1}
    if any(abs(normalized['original'][k])>2**53-1 for k in ('originMonotonicNs','deadlineMonotonicNs')):raise ValueError('Exact JS clock representation required')
    c.validate(config['clock']);envelope(original,continuous);verify_pins(config['pins'])
    c.write_new(parent/'bootstrap-entry.intent',c.encode({'unit':unit,'clock':config['clock'],'relay':config['relay'],'resource':resource,'rpcReady':False}))
    cfg=sealed(normalized)
    # Move all sources above target FDs before remapping to avoid collisions.
    fds=[fcntl.fcntl(fd,fcntl.F_DUPFD_CLOEXEC,20) for fd in (cfg,key,cert,seeds['l1-seed'],seeds['base-seed'])]
    for fd in (cfg,key,cert,seeds['l1-seed'],seeds['base-seed']):os.close(fd)
    for target,fd in enumerate(fds,3):os.dup2(fd,target,inheritable=True)
    for fd in fds:os.close(fd)
    env={'PATH':'/usr/bin:/bin','NODE_OPTIONS':'','HOME':str(parent)}
    for name in ('XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','INVOCATION_ID'):
        if name in os.environ:env[name]=os.environ[name]
    os.execve('/usr/bin/node',['/usr/bin/node',str(HERE/'owner_bootstrap.mjs')],env)


if __name__=='__main__':
    if len(sys.argv)!=2:raise SystemExit('One protected bootstrap configuration required')
    try:main(sys.argv[1])
    except Exception:
        print('Owner bootstrap refused; attempt retained',file=sys.stderr);raise SystemExit(1)

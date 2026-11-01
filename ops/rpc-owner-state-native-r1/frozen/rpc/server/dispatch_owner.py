"""One-shot owner signer -> guarded export submission, without a writable grant.

Invoked only in an admitted independent dispatcher unit. Consumes durable local
submission records before each systemd call. Any uncertainty stays held; no
retry, unit replacement, refund, reservation release or implicit adoption.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import subprocess
import sys
import time

HERE=Path(__file__).resolve().parent


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


entry=load('rpc_owner_entry',HERE/'owner_entry.py')
c=entry.clock_module()


def run_signer(args,request,deadline):
    """Bound transport output too; timeout does not imply remote unit death."""
    proc=subprocess.Popen(args,stdin=request,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    sel=selectors.DefaultSelector();out=bytearray();error=bytearray()
    try:
        for pipe,name in ((proc.stdout,'stdout'),(proc.stderr,'stderr')):
            os.set_blocking(pipe.fileno(),False);sel.register(pipe,selectors.EVENT_READ,name)
        while sel.get_map():
            if time.monotonic()>=deadline:raise TimeoutError('Signer response ambiguous; intent retained')
            for key,_ in sel.select(.05):
                data=os.read(key.fileobj.fileno(),4096)
                if not data:sel.unregister(key.fileobj);continue
                target=out if key.data=='stdout' else error;target.extend(data)
                if len(target)>(2048 if key.data=='stdout' else 8192):raise ValueError('Signer response bound')
        if proc.wait(timeout=max(.001,deadline-time.monotonic()))!=0:raise ValueError('Signer refused; records retained')
        return bytes(out)
    finally:
        sel.close()
        if proc.poll() is None:proc.kill();proc.wait(timeout=1)
        proc.stdout.close();proc.stderr.close()


def dispatcher_envelope(original):
    unit='enclave-rpc-owner-dispatch-'+original['attempt']+'.service';row=entry.show(unit)
    expected={'Id':unit,'MainPID':str(os.getpid()),'InvocationID':os.environ.get('INVOCATION_ID',''),
        'Type':'exec','RuntimeMaxUSec':'1min','TimeoutStopUSec':'1s','MemoryMax':str(256<<20),
        'MemorySwapMax':'0','CPUQuotaPerSecUSec':'1s','TasksMax':'32','KillMode':'control-group',
        'Restart':'no','SendSIGKILL':'yes','FinalKillSignal':'9','NoNewPrivileges':'yes','LimitCORE':'0'}
    if (not re.fullmatch('[0-9a-f]{32}',expected['InvocationID']) or any(row[k]!=v for k,v in expected.items())
            or Path('/proc/self/cgroup').read_text().strip()!='0::'+row['ControlGroup']):raise ValueError('Independent dispatcher envelope differs')
    start=int(row['ExecMainStartTimestampMonotonic'])*1000
    if not 0<=time.monotonic_ns()-start<5_000_000_000 or start+63_000_000_000>=original['deadlineMonotonicNs']:
        raise ValueError('Dispatcher cutoff does not fit original owner window')
    return row


def dispatch(config):
    fields={'schema','entry','request','outputParent','pins'}
    if set(config)!=fields or config['schema']!='enclave-rpc-owner-dispatch/1':raise ValueError('Exact owner dispatcher configuration required')
    # Pin the complete imported maintained RPC closure before loading legacy
    # lifecycle helpers. No dated snapshot or caller-selected executable is used.
    required={str(p) for p in HERE.parent.rglob('*.py')}
    required|={'/usr/bin/python3','/usr/bin/systemd-run','/usr/bin/systemctl','/usr/bin/bwrap','/usr/bin/node'}
    if set(config['pins'])!=required:raise ValueError('Complete dispatcher runtime closure required')
    for path,wanted in config['pins'].items():
        c.protocol.digest(wanted)
        with open(path,'rb') as f:
            if hashlib.file_digest(f,'sha256').hexdigest()!=wanted:raise ValueError('Dispatcher runtime pin changed')
    startup=load('rpc_owner_startup',HERE.parent/'run_startup.py')
    entry_raw=c.read_pinned(config['entry']);cfg=c.protocol.decode(entry_raw)
    original=c.validate(cfg['clock']);dispatcher_envelope(original)
    if cfg['attempt']!=original['attempt']:raise ValueError('Signer attempt differs')
    contract_raw=c.read_pinned(cfg['contract']);contract=c.protocol.decode(contract_raw)
    if contract['startupClock']!=cfg['clock'] or contract['attempt']!=original['attempt'] or 'appControl' not in contract:
        raise ValueError('Original native-app export contract required')
    policy_raw=c.read_pinned(cfg['policy']);policy=c.protocol.decode(policy_raw)
    if policy['export']['contractSha256']!=cfg['contract']['sha256']:raise ValueError('Signed contract pin differs')
    owner=load('rpc_dispatch_owner_state',HERE/'owner_state.py')
    owner.inspect(cfg['ownerProvision'],contract,policy)
    journal=Path(cfg['ownerProvision']['path']).parent/'journal'
    output=c.directory(config['outputParent'])/original['attempt']
    if cfg['receipt']!=str(output/'signer-started.json'):raise ValueError('Original dispatcher receipt namespace required')
    # Authoritative admission includes signer128 + dispatcher256 + exporter384
    # and explicit bootstrap/collector allowance. Pending is never assumed zero.
    observer=contract['resourceArgv']
    if len(observer)!=3 or observer[:2]!=['/usr/bin/node',str(HERE/'observe_resources.mjs')]:raise ValueError('Maintained local resource authority required')
    for path in observer:
        with open(path,'rb') as f:
            if hashlib.file_digest(f,'sha256').hexdigest()!=contract['sourcePins'][path]:raise ValueError('Resource reader/config changed')
    result=subprocess.run(observer,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=3,check=True)
    if len(result.stdout)>65536:raise ValueError('Resource observation bound')
    resource=c.protocol.decode(result.stdout)
    if (resource.get('authenticated') is not True or resource.get('unreadUnits')!=0
            or any(type(resource.get(k)) is not int or resource[k]<0 for k in ('availableMiB','pendingMiB','floorMiB'))
            or resource['availableMiB']-resource['pendingMiB']-1024<max(27648,contract['floorMiB'],resource['floorMiB'])):
        raise ValueError('Whole owner service resource admission refused')
    request_binding=config['request']
    if set(request_binding)!={'path','sha256'}:raise ValueError('Pinned request required')
    request_fd=entry.held(request_binding['path'],4<<20,wanted=request_binding['sha256'])
    lease=None
    try:
        request_raw=os.read(request_fd,(4<<20)+1);os.lseek(request_fd,0,os.SEEK_SET)
        request=c.protocol.decode(request_raw)['request']
        request_sha=hashlib.sha256(json.dumps(request,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        if request_sha!=contract['appControl']['requestSha256']:raise ValueError('Contract request differs')
        c.validate(cfg['clock']);output.mkdir(mode=0o700);c.sync_directory(output.parent)
        unit='enclave-rpc-owner-sign-'+original['attempt']+'.service'
        c.write_new(output/'signer-submit.intent',c.encode({'attempt':original['attempt'],'entry':config['entry'],
            'request':request_binding,'clock':cfg['clock'],'unit':unit,'resource':resource}))
        props=['Type=exec','RuntimeMaxSec=20','TimeoutStopSec=1','MemoryMax=128M','MemorySwapMax=0','CPUQuota=100%',
            'TasksMax=32','KillMode=control-group','Restart=no','SendSIGKILL=yes','FinalKillSignal=SIGKILL','NoNewPrivileges=yes','LimitCORE=0','UMask=0077']
        args=['/usr/bin/systemd-run','--user','--quiet','--wait','--pipe','--unit='+unit,*['--property='+p for p in props],
            '/usr/bin/python3','-B',str(HERE/'owner_entry.py'),config['entry']['path']]
        proof_raw=run_signer(args,request_fd,min(time.monotonic()+24,original['deadlineMonotonicNs']/1e9))
        proof=c.protocol.decode(proof_raw)
        if proof.get('schema')!='enclave-rpc-storage-consent/2' or proof.get('export')!=policy['export']:raise ValueError('Owner response binding differs')
        # Exact durable response already exists in the owner's authoritative
        # journal. Read it by a held fd; never create/reconstruct/replay it here.
        owner.inspect(cfg['ownerProvision'],contract,policy)
        fd=entry.held(str(journal/('proof-'+request_sha)),2048,0o400,wanted=hashlib.sha256(proof_raw).hexdigest())
        os.close(fd)
        started=c.protocol.decode(c.read(output/'signer-started.json'))
        if started['attempt']!=original['attempt'] or started['clock']!=cfg['clock'] or started['contract']!=cfg['contract'] or started['binary']!=cfg['binary'] or started['unit']['Id']!=unit:
            raise ValueError('Actual signer invocation receipt differs')
        c.validate(cfg['clock'])
        if c.read_pinned(config['entry'])!=entry_raw or c.read_pinned(cfg['contract'])!=contract_raw or c.read_pinned(cfg['policy'])!=policy_raw:raise ValueError('Owner inputs changed')
        c.write_new(output/'signer-result.json',c.encode({'proof':proof,'signer':started,'rpcReady':False}))
        export_unit='enclave-rpc-export-'+original['attempt']+'.service'
        c.write_new(output/'export-submit.intent',c.encode({'unit':export_unit,'clock':cfg['clock'],
            'contract':cfg['contract'],'requestSha256':request_sha,'proofSha256':hashlib.sha256(proof_raw).hexdigest()}))
        # This is the actual maintained unit launcher, not a callback or echo.
        lease=startup.start_export(cfg['clock'],cfg['contract'])
        identity=lease.check()
        c.write_new(output/'export-submitted.json',c.encode({'exporter':identity,'rpcReady':False,'writersFenced':False}))
        # A bound watchdog is earlier than TLS bind. Do not return consent until
        # the exact export process has created its control-listening marker.
        marker=Path(contract['stateParent'])/original['attempt']/'control-listening.json'
        until=min(time.monotonic()+3,original['deadlineMonotonicNs']/1e9)
        while not marker.exists():
            c.validate(cfg['clock']);lease.check()
            if time.monotonic()>=until:raise TimeoutError('Control listener not observed; export intent held')
            time.sleep(.025)
        row=c.protocol.decode(c.read(marker))
        if row!={'contractSha256':cfg['contract']['sha256'],'requestSha256':request_sha,'bound':False,'rpcReady':False}:raise ValueError('Exact control listening receipt required')
        c.validate(cfg['clock']);lease.check()
        reply={'schema':'enclave-rpc-owner-dispatched/1','attempt':original['attempt'],'proof':proof,
            'exporter':identity,'rpcReady':False,'writersFenced':False,'reservationMayRelease':False}
        c.write_new(output/'response.json',c.encode(reply))
        return reply
    finally:
        os.close(request_fd)
        if lease is not None:lease.close()  # observation handle only, never cancel/release


if __name__=='__main__':
    os.umask(0o077)
    if len(sys.argv)!=2:raise SystemExit('One protected dispatcher configuration required')
    print(json.dumps(dispatch(c.protocol.decode(c.read(sys.argv[1]))),sort_keys=True),flush=True)

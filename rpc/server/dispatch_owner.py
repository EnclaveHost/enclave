"""One-shot owner signer -> guarded export submission, without a writable grant.

Invoked only in an admitted independent dispatcher unit. Consumes durable local
submission records before each systemd call. Any uncertainty stays held; no
retry, unit replacement, refund, reservation release or implicit adoption.
"""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import sys
import time

HERE=Path(__file__).resolve().parent


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


entry=load('rpc_owner_entry',HERE/'owner_entry.py')
c=entry.clock_module()


def decode_owner_request(raw):
    """Bound the real bundle-bearing wire separately from small public contracts.

    This validates encoding/size, NOT app permission. The actual Go owner actor
    still parses the contract and obtains independent chain authorization.
    """
    if not isinstance(raw,bytes) or not 0<len(raw)<=4<<20:
        raise ValueError('Bounded complete owner request required')
    def pairs(rows):
        result={}
        for key,value in rows:
            if key in result:raise ValueError('Duplicate owner request field')
            result[key]=value
        return result
    value=json.loads(raw,object_pairs_hook=pairs)
    if not isinstance(value,dict) or set(value)!={'bundle','manifest','request'} or not isinstance(value['request'],dict):
        raise ValueError('Complete owner request fields required')
    for key,limit in (('bundle',2<<20),('manifest',65536)):
        encoded=value[key]
        if not isinstance(encoded,str):raise ValueError('Base64 owner input required')
        decoded=base64.b64decode(encoded,validate=True)
        if not 0<len(decoded)<=limit or base64.b64encode(decoded).decode()!=encoded:
            raise ValueError('Bounded canonical base64 owner input required')
    canonical=json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True,allow_nan=False).encode()
    if raw.strip()!=canonical or len(json.dumps(value['request'],sort_keys=True,separators=(',',':')).encode())>2048:
        raise ValueError('Canonical bounded owner request required')
    return value


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


def dispatcher_envelope(original,continuous=False):
    unit='enclave-rpc-owner-dispatch-'+('stream-' if continuous else '')+original['attempt']+'.service';row=entry.show(unit)
    expected={'Id':unit,'MainPID':str(os.getpid()),'InvocationID':os.environ.get('INVOCATION_ID',''),
        'Type':'exec','RuntimeMaxUSec':'1min','TimeoutStopUSec':'1s','MemoryMax':str(256<<20),
        'MemorySwapMax':'0','CPUQuotaPerSecUSec':'1s','TasksMax':'32','KillMode':'control-group',
        'Restart':'no','SendSIGKILL':'yes','FinalKillSignal':'9','NoNewPrivileges':'yes','LimitCORE':'0'}
    if continuous:
        entry.stream_envelope(row,original)
        expected['RuntimeMaxUSec']=row['RuntimeMaxUSec']
    if (not re.fullmatch('[0-9a-f]{32}',expected['InvocationID']) or any(row[k]!=v for k,v in expected.items())
            or Path('/proc/self/cgroup').read_text().strip()!='0::'+row['ControlGroup']):raise ValueError('Independent dispatcher envelope differs')
    start=int(row['ExecMainStartTimestampMonotonic'])*1000
    if not continuous and (not 0<=time.monotonic_ns()-start<5_000_000_000 or start+63_000_000_000>=original['deadlineMonotonicNs']):
        raise ValueError('Dispatcher cutoff does not fit original owner window')
    return row


def dispatch(config,stream_io=None):
    fields={'schema','entry','request','outputParent','pins'}
    if set(config)!=fields or config['schema'] not in ('enclave-rpc-owner-dispatch/1','enclave-rpc-owner-dispatch/2'):raise ValueError('Exact owner dispatcher configuration required')
    continuous=config['schema']=='enclave-rpc-owner-dispatch/2'
    if continuous:
        if not isinstance(stream_io,tuple) or len(stream_io)!=2 or any(type(fd) is not int or not stat.S_ISFIFO(os.fstat(fd).st_mode) for fd in stream_io):
            raise ValueError('Original continuous relay pipes required')
        for fd in stream_io:os.set_blocking(fd,False)
    elif stream_io is not None:raise ValueError('One-shot dispatcher cannot accept continuation pipes')
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
    original=c.validate(cfg['clock']);dispatcher_envelope(original,continuous)
    if continuous and cfg.get('schema')!='enclave-rpc-owner-entry/2':raise ValueError('Explicit continuous signer entry required')
    if cfg['attempt']!=original['attempt']:raise ValueError('Signer attempt differs')
    contract_raw=c.read_pinned(cfg['contract']);contract=c.protocol.decode(contract_raw)
    if contract['startupClock']!=cfg['clock'] or contract['attempt']!=original['attempt'] or 'appControl' not in contract:
        raise ValueError('Original native-app export contract required')
    policy_raw=c.read_pinned(cfg['policy']);policy=c.protocol.decode(policy_raw)
    if continuous and policy.get('schema')!='enclave-rpc-storage-owner/2':raise ValueError('Explicit continuous owner policy required')
    if not continuous and (cfg.get('schema')=='enclave-rpc-owner-entry/2' or policy.get('schema')=='enclave-rpc-storage-owner/2'):raise ValueError('Owner protocol downgrade refused')
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
    lease=None;live=None
    try:
        request_raw=os.read(request_fd,(4<<20)+1);os.lseek(request_fd,0,os.SEEK_SET)
        request=decode_owner_request(request_raw)['request']
        request_sha=hashlib.sha256(json.dumps(request,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        if request_sha!=contract['appControl']['requestSha256']:raise ValueError('Contract request differs')
        c.validate(cfg['clock']);output.mkdir(mode=0o700);c.sync_directory(output.parent)
        unit='enclave-rpc-owner-sign-'+('stream-' if continuous else '')+original['attempt']+'.service'
        runtime=entry.stream_runtime(original) if continuous else 20
        c.write_new(output/'signer-submit.intent',c.encode({'attempt':original['attempt'],'entry':config['entry'],
            'request':request_binding,'clock':cfg['clock'],'unit':unit,'resource':resource,'runtimeSeconds':runtime}))
        props=['Type=exec','RuntimeMaxSec='+str(runtime),'TimeoutStopSec=1','MemoryMax=128M','MemorySwapMax=0','CPUQuota=100%',
            'TasksMax=32','KillMode=control-group','Restart=no','SendSIGKILL=yes','FinalKillSignal=SIGKILL','NoNewPrivileges=yes','LimitCORE=0','UMask=0077']
        args=['/usr/bin/systemd-run','--user','--quiet','--wait','--pipe','--unit='+unit,*['--property='+p for p in props],
            '/usr/bin/python3','-B',str(HERE/'owner_entry.py'),config['entry']['path']]
        if continuous:
            streaming=load('rpc_owner_signer_stream',HERE/'owner_signer_stream.py')
            live=streaming.LiveSigner(args,original['deadlineMonotonicNs']/1e9)
            proof_raw=live.exchange(request_raw.strip(),2048,min(time.monotonic()+24,live.deadline))
        else:
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
        if live is not None:live.check()
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
            if live is not None:live.check()
            if time.monotonic()>=until:raise TimeoutError('Control listener not observed; export intent held')
            time.sleep(.025)
        row=c.protocol.decode(c.read(marker))
        if row!={'contractSha256':cfg['contract']['sha256'],'requestSha256':request_sha,'bound':False,'rpcReady':False}:raise ValueError('Exact control listening receipt required')
        c.validate(cfg['clock']);lease.check()
        if live is not None:live.check()
        reply={'schema':'enclave-rpc-owner-dispatched/'+('2' if continuous else '1'),'attempt':original['attempt'],'proof':base64.b64encode(proof_raw).decode() if continuous else proof,
            'exporter':identity,'rpcReady':False,'writersFenced':False,'reservationMayRelease':False}
        c.write_new(output/'response.json',c.encode(reply))
        if continuous:
            # Fixed original relay namespace, not a caller-selected journal.
            relay_root=c.directory(Path(cfg['clock']['path']).parent/'relay')
            c.write_new(relay_root/'response.json',c.encode(reply))
            live.send_peer(stream_io[1],c.encode(reply),min(time.monotonic()+3,live.deadline))
            forward_continuations(live,stream_io,cfg,original,journal,request_sha,proof_raw,output,lease)
            raise ValueError('Continuous owner unexpectedly returned; held')
        return reply
    finally:
        os.close(request_fd)
        if live is not None:live.close()
        if lease is not None:lease.close()  # observation handle only, never cancel/release


def forward_continuations(live,stream_io,cfg,original,journal,request_sha,proof_raw,output,lease):
    """Transport only: original Go actor remains signature/chain authority.

    At most 90 responses in the original 900s startup window bounds durable
    growth. A lost response, exhausted count or EOF never reacquires writers.
    """
    previous=hashlib.sha256(proof_raw).hexdigest()
    for sequence in range(1,91):
        c.validate(cfg['clock']);lease.check()
        raw=live.read_peer(stream_io[0],1024,min(time.monotonic()+30,live.deadline))
        until=min(time.monotonic()+3,live.deadline)
        p=c.protocol.decode(raw)
        if (set(p)!={'schema','phase','sequence','previousSha256','readinessSha256','issuedAt','notAfter'} or
                p['schema']!='enclave-rpc-continuation/1' or p['phase']!='startup' or p['readinessSha256']!='' or
                type(p['sequence']) is not int or p['sequence']!=sequence or p['previousSha256']!=previous):
            raise ValueError('Exact next startup continuation required')
        c.write_new(output/('continuation-%016x-submit'%sequence),raw)
        c.validate(cfg['clock']);lease.check()
        reply=live.exchange(raw,2048,until)
        value=c.protocol.decode(reply)
        if set(value)!={'permit','l1','base'} or value['permit']!=p:raise ValueError('Signer continuation binding differs')
        # No reconstructed proof: the live actor must have persisted these exact
        # bytes before the dispatcher acknowledges any continuation.
        digest=hashlib.sha256(reply).hexdigest()
        fd=entry.held(str(journal/('continuation-%s-%016x-proof'%(request_sha,sequence))),2048,0o400,wanted=digest)
        os.close(fd)
        c.write_new(output/('continuation-%016x-proof'%sequence),reply)
        c.validate(cfg['clock']);lease.check()
        live.send_peer(stream_io[1],reply,until)
        previous=digest
    raise ValueError('Original startup continuation count exhausted; held')


if __name__=='__main__':
    os.umask(0o077)
    if len(sys.argv)!=2:raise SystemExit('One protected dispatcher configuration required')
    print(json.dumps(dispatch(c.protocol.decode(c.read(sys.argv[1]))),sort_keys=True),flush=True)

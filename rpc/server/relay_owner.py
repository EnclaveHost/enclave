"""Framed one-shot owner entrypoint in the EXISTING independent dispatcher unit.

Accepts public bytes matching one previously prepared, protected owner request.
No network listener, request-selected configuration, key transfer, retry, grant
or cancellation API. An authenticated bootstrap transport still has to launch
this command once in enclave-rpc-owner-dispatch-ATTEMPT.service (256MiB/60s).
"""
import hashlib
import importlib.util
import os
from pathlib import Path
import select
import stat
import struct
import sys
import time

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('rpc_relay_dispatch',HERE/'dispatch_owner.py')
d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)
c=d.c


def transport(fd):
    row=os.fstat(fd)
    if not stat.S_ISFIFO(row.st_mode):
        raise ValueError('Inherited bootstrap pipes required (no socket descriptor transfer)')
    os.set_blocking(fd,False)


def read_exact(fd,size,deadline):
    data=bytearray()
    while len(data)<size:
        remaining=deadline-time.monotonic()
        if remaining<=0:raise TimeoutError('Original owner ingress cutoff')
        ready,_,_=select.select([fd],[],[],min(remaining,.05))
        if not ready:continue
        try:chunk=os.read(fd,min(65536,size-len(data)))
        except (BlockingIOError,InterruptedError):continue
        if not chunk:raise ValueError('Incomplete owner frame; consumed')
        data.extend(chunk)
    return bytes(data)


def write_frame(fd,raw,deadline):
    if not 0<len(raw)<=65536:raise ValueError('Owner response bound')
    data=memoryview(struct.pack('!I',len(raw))+raw)
    while data:
        remaining=deadline-time.monotonic()
        if remaining<=0:raise TimeoutError('Owner response ambiguous; retained')
        _,ready,_=select.select([],[fd],[],min(remaining,.05))
        if not ready:continue
        try:n=os.write(fd,data)
        except (BlockingIOError,InterruptedError):continue
        if n<=0:raise ValueError('Owner response write failed; retained')
        data=data[n:]


def run(config,input_fd=0,output_fd=1):
    if set(config)!={'schema','dispatcher'} or config['schema'] not in ('enclave-rpc-owner-relay/1','enclave-rpc-owner-relay/2'):
        raise ValueError('Exact protected owner relay configuration required')
    continuous=config['schema']=='enclave-rpc-owner-relay/2'
    dispatch_raw=c.read_pinned(config['dispatcher']);cfg=c.protocol.decode(dispatch_raw)
    if cfg['schema']!='enclave-rpc-owner-dispatch/'+('2' if continuous else '1'):raise ValueError('Owner relay/dispatcher protocol differs')
    entry_raw=c.read_pinned(cfg['entry']);entry=c.protocol.decode(entry_raw)
    original=c.validate(entry['clock'])
    if entry['attempt']!=original['attempt']:raise ValueError('Original relay attempt differs')
    unit=d.dispatcher_envelope(original,continuous)  # Same process, unit, limits and deadline.
    start=int(unit['ExecMainStartTimestampMonotonic'])/1e6
    deadline=original['deadlineMonotonicNs']/1e9 if continuous else min(start+60,original['deadlineMonotonicNs']/1e9)
    ingress=min(start+3,deadline)
    # All maintained imports/tools are pinned before input and rechecked by the
    # dispatcher before keys or export work. No caller-selected executable.
    paths={str(p) for p in HERE.parent.rglob('*.py')}|{'/usr/bin/python3','/usr/bin/systemd-run','/usr/bin/systemctl','/usr/bin/bwrap','/usr/bin/node'}
    if set(cfg['pins'])!=paths:raise ValueError('Complete owner relay runtime closure required')
    for path,wanted in cfg['pins'].items():
        c.protocol.digest(wanted)
        with open(path,'rb') as f:
            if hashlib.file_digest(f,'sha256').hexdigest()!=wanted:raise ValueError('Owner relay source changed')
    binding=cfg['request']
    if set(binding)!={'path','sha256'}:raise ValueError('Pinned prepared request required')
    fd=d.entry.held(binding['path'],4<<20,wanted=binding['sha256'])
    try:prepared=os.read(fd,(4<<20)+1)
    finally:os.close(fd)
    value=d.decode_owner_request(prepared)
    expected=c.encode(value).strip()
    # Single permanent owner-side ingress name, including failed/partial input.
    # The actual dispatcher retains its separate signer/export submission log.
    root=c.directory(Path(entry['clock']['path']).parent)/'relay'
    root.mkdir(mode=0o700);c.sync_directory(root.parent)
    c.write_new(root/'ingress.intent',c.encode({'schema':'enclave-rpc-owner-ingress/1',
        'attempt':original['attempt'],'dispatcher':config['dispatcher'],
        'request':binding,'wireSha256':hashlib.sha256(expected).hexdigest(),'unit':unit,
        'rpcReady':False,'reservationMayRelease':False}))
    transport(input_fd);transport(output_fd)
    size=struct.unpack('!I',read_exact(input_fd,4,ingress))[0]
    if not 0<size<=4<<20:raise ValueError('Bounded owner request frame required')
    raw=read_exact(input_fd,size,ingress)
    if raw!=expected:raise ValueError('Wire request differs from prepared owner binding')
    ready,_,_=select.select([input_fd],[],[],0)
    if ready:
        extra=os.read(input_fd,1)
        if extra or continuous:raise ValueError('Extra request bytes or continuous peer EOF; consumed')
    c.validate(entry['clock'])
    if c.read_pinned(config['dispatcher'])!=dispatch_raw or c.read_pinned(cfg['entry'])!=entry_raw:
        raise ValueError('Prepared dispatcher changed')
    c.write_new(root/'dispatch.intent',c.encode({'attempt':original['attempt'],
        'requestSha256':hashlib.sha256(raw).hexdigest(),'unit':unit}))
    # Actual maintained implementation, not an injected production callback.
    # It checks the same unit again, persists signer intent BEFORE submission,
    # verifies durable proof, persists exporter identity BEFORE returning.
    if continuous:
        # The actual dispatcher keeps its original signer and export observation
        # alive. It persists BOTH dispatcher/relay responses before first wire.
        # No /1 callback, reconstructed session or second owner submission.
        return d.dispatch(cfg,stream_io=(input_fd,output_fd))
    reply=d.dispatch(cfg)
    if (reply.get('schema')!='enclave-rpc-owner-dispatched/1' or reply.get('attempt')!=original['attempt']
            or any(reply.get(k) is not False for k in ('rpcReady','writersFenced','reservationMayRelease'))):
        raise ValueError('Unqualified owner result; retained')
    response=c.encode(reply)
    persisted=c.read(Path(cfg['outputParent'])/original['attempt']/'response.json')
    if persisted!=response:raise ValueError('Exact durable dispatcher response required')
    c.validate(entry['clock'])
    c.write_new(root/'response.json',response)  # BEFORE acknowledgment.
    write_frame(output_fd,response,deadline)
    return {'rpcReady':False,'reservationMayRelease':False}


if __name__=='__main__':
    os.umask(0o077)
    if len(sys.argv)!=2:raise SystemExit('One protected owner relay configuration required')
    try:run(c.protocol.decode(c.read(sys.argv[1])))
    except Exception:
        # Diagnostics must not expose private paths, config or request material.
        print('Owner relay refused; attempt and ambiguous results retained',file=sys.stderr)
        raise SystemExit(1)

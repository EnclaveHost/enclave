"""Internal fixed forwarder: real pipes to ONE independently bounded dispatcher.

Node child stdio may be socketpairs; deliberately create pipes for the existing
relay's strict FIFO interface. Killing this transport never proves remote death.
No executable/config arguments; only the parent's sealed readonly FD3.
"""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import selectors
import struct
import subprocess
import sys
import time

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('rpc_owner_bootstrap_entry',HERE/'owner_bootstrap_entry.py')
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
c=b.c


def forward_stream(cfg,original,parent,args,raw,input_fd=0,output_fd=1):
    """Retain one dispatcher. Output loss never permits another submission."""
    spec=importlib.util.spec_from_file_location('rpc_bootstrap_live_pipe',HERE/'owner_signer_stream.py')
    live_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(live_module)
    os.set_blocking(input_fd,False);os.set_blocking(output_fd,False)
    live=live_module.LiveSigner(args,original['deadlineMonotonicNs']/1e9)
    try:
        response=live.exchange(raw,65536,min(time.monotonic()+27,live.deadline))
        value=c.protocol.decode(response)
        if (value.get('schema')!='enclave-rpc-owner-dispatched/2' or value.get('attempt')!=original['attempt'] or
                any(value.get(k) is not False for k in ('rpcReady','writersFenced','reservationMayRelease'))):
            raise ValueError('Original stream dispatcher response required')
        if c.read(parent/'relay'/'response.json')!=response:raise ValueError('Durable original stream response differs')
        c.validate(cfg['clock']);c.write_new(parent/'bootstrap'/'response.json',response)
        live.send_peer(output_fd,response,min(time.monotonic()+3,live.deadline))
        for sequence in range(1,91):
            request=live.read_peer(input_fd,1024,min(time.monotonic()+30,live.deadline))
            until=min(time.monotonic()+3,live.deadline)
            c.validate(cfg['clock'])
            c.write_new(parent/'bootstrap'/('continuation-%016x-submit'%sequence),request)
            reply=live.exchange(request,2048,until)
            c.validate(cfg['clock'])
            c.write_new(parent/'bootstrap'/('continuation-%016x-response'%sequence),reply)
            live.send_peer(output_fd,reply,until)
        raise ValueError('Original continuation count exhausted; held')
    finally:live.close()


def run():
    seals=fcntl.F_SEAL_SEAL|fcntl.F_SEAL_SHRINK|fcntl.F_SEAL_GROW|fcntl.F_SEAL_WRITE
    if fcntl.fcntl(3,fcntl.F_GET_SEALS)!=seals:raise ValueError('Sealed original bootstrap configuration required')
    size=os.fstat(3).st_size
    if not 0<size<=8<<20:raise ValueError('Bootstrap configuration bound')
    cfg=json.loads(os.pread(3,size,0));b.verify_pins(cfg['pins']);original=c.validate(cfg['clock'])
    if cfg['original']!={**{k:original[k] for k in ('attempt','originMonotonicNs','deadlineMonotonicNs')},'boot':original['bootId']}:raise ValueError('Original owner clock differs')
    relay=c.protocol.decode(c.read_pinned(cfg['relay']))
    version=cfg.get('ownerProtocol',1)
    if type(version) is not int or version not in (1,2) or relay.get('schema')!='enclave-rpc-owner-relay/'+str(version):raise ValueError('Matching sealed owner protocol required')
    continuous=version==2
    parent=c.directory(Path(cfg['clock']['path']).parent)
    intent=c.protocol.decode(c.read(parent/'bootstrap'/'dispatch.intent'))
    raw=cfg['prepared'].encode()
    if intent['wireSha256']!=hashlib.sha256(raw).hexdigest():raise ValueError('Consumed exact dispatch required')
    # Independent dispatcher lifetime must fit the same original clock, too.
    if c.remaining(cfg['clock'])<65:raise ValueError('Original dispatch time exhausted')
    runtime=b.e.stream_runtime(original) if continuous else 60
    unit='enclave-rpc-owner-dispatch-'+('stream-' if continuous else '')+original['attempt']+'.service'
    props=['Type=exec','RuntimeMaxSec='+str(runtime),'TimeoutStopSec=1','MemoryMax=256M','MemorySwapMax=0','CPUQuota=100%',
        'TasksMax=32','KillMode=control-group','Restart=no','SendSIGKILL=yes','FinalKillSignal=SIGKILL','NoNewPrivileges=yes','LimitCORE=0','UMask=0077']
    args=['/usr/bin/systemd-run','--user','--quiet','--wait','--pipe','--unit='+unit,*['--property='+p for p in props],
        '/usr/bin/python3','-B',str(HERE/'relay_owner.py'),cfg['relay']['path']]
    # Durable record BEFORE Popen, even when systemd's response is lost.
    c.write_new(parent/'bootstrap'/'relay-submit.intent',c.encode({'unit':unit,'clock':cfg['clock'],'relay':cfg['relay'],'runtimeSeconds':runtime,'rpcReady':False}))
    if continuous:return forward_stream(cfg,original,parent,args,raw)
    proc=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    sel=selectors.DefaultSelector();out=bytearray();error=bytearray();wire=memoryview(struct.pack('!I',len(raw))+raw)
    until=min(time.monotonic()+63,original['deadlineMonotonicNs']/1e9)
    try:
        for pipe,event,name in ((proc.stdin,selectors.EVENT_WRITE,'in'),(proc.stdout,selectors.EVENT_READ,'out'),(proc.stderr,selectors.EVENT_READ,'err')):
            os.set_blocking(pipe.fileno(),False);sel.register(pipe,event,name)
        while sel.get_map():
            if time.monotonic()>=until:raise TimeoutError('Dispatcher outcome ambiguous')
            for k,_ in sel.select(.05):
                if k.data=='in':
                    try:n=os.write(k.fd,wire[:65536])
                    except BlockingIOError:continue
                    wire=wire[n:]
                    if not wire:sel.unregister(k.fileobj);k.fileobj.close()
                else:
                    try:chunk=os.read(k.fd,4096)
                    except BlockingIOError:continue
                    if not chunk:sel.unregister(k.fileobj);continue
                    target=out if k.data=='out' else error;target.extend(chunk)
                    if len(target)>(65540 if k.data=='out' else 8192):raise ValueError('Dispatcher output bound')
        if proc.wait(timeout=max(.001,until-time.monotonic()))!=0:raise ValueError('Dispatcher refused; held')
        if len(out)<5 or struct.unpack('!I',out[:4])[0]!=len(out)-4:raise ValueError('Exact framed dispatcher response required')
        response=bytes(out[4:]);value=c.protocol.decode(response)
        if value.get('schema')!='enclave-rpc-owner-dispatched/1' or value.get('attempt')!=original['attempt'] or any(value.get(k) is not False for k in ('rpcReady','writersFenced','reservationMayRelease')):raise ValueError('Unqualified dispatcher result')
        if c.read(parent/'relay'/'response.json')!=response:raise ValueError('Durable original relay response differs')
        c.validate(cfg['clock']);c.write_new(parent/'bootstrap'/'response.json',response)
        sys.stdout.buffer.write(out);sys.stdout.buffer.flush()
    finally:
        sel.close()
        if proc.poll() is None:proc.kill();proc.wait(timeout=1)
        for pipe in (proc.stdin,proc.stdout,proc.stderr):pipe.close()


if __name__=='__main__':
    if len(sys.argv)!=1:raise SystemExit('No submission arguments accepted')
    try:run()
    except Exception:
        print('Owner submission ambiguous or refused; retained',file=sys.stderr);raise SystemExit(1)

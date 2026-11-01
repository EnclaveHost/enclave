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


def run():
    seals=fcntl.F_SEAL_SEAL|fcntl.F_SEAL_SHRINK|fcntl.F_SEAL_GROW|fcntl.F_SEAL_WRITE
    if fcntl.fcntl(3,fcntl.F_GET_SEALS)!=seals:raise ValueError('Sealed original bootstrap configuration required')
    size=os.fstat(3).st_size
    if not 0<size<=8<<20:raise ValueError('Bootstrap configuration bound')
    cfg=json.loads(os.pread(3,size,0));b.verify_pins(cfg['pins']);original=c.validate(cfg['clock'])
    if cfg['original']!={**{k:original[k] for k in ('attempt','originMonotonicNs','deadlineMonotonicNs')},'boot':original['bootId']}:raise ValueError('Original owner clock differs')
    relay=c.protocol.decode(c.read_pinned(cfg['relay']))
    parent=c.directory(Path(cfg['clock']['path']).parent)
    intent=c.protocol.decode(c.read(parent/'bootstrap'/'dispatch.intent'))
    raw=cfg['prepared'].encode()
    if intent['wireSha256']!=hashlib.sha256(raw).hexdigest():raise ValueError('Consumed exact dispatch required')
    # Independent dispatcher lifetime must fit the same original clock, too.
    if c.remaining(cfg['clock'])<65:raise ValueError('Original dispatch time exhausted')
    unit='enclave-rpc-owner-dispatch-'+original['attempt']+'.service'
    props=['Type=exec','RuntimeMaxSec=60','TimeoutStopSec=1','MemoryMax=256M','MemorySwapMax=0','CPUQuota=100%',
        'TasksMax=32','KillMode=control-group','Restart=no','SendSIGKILL=yes','FinalKillSignal=SIGKILL','NoNewPrivileges=yes','LimitCORE=0','UMask=0077']
    args=['/usr/bin/systemd-run','--user','--quiet','--wait','--pipe','--unit='+unit,*['--property='+p for p in props],
        '/usr/bin/python3','-B',str(HERE/'relay_owner.py'),cfg['relay']['path']]
    # Durable record BEFORE Popen, even when systemd's response is lost.
    c.write_new(parent/'bootstrap'/'relay-submit.intent',c.encode({'unit':unit,'clock':cfg['clock'],'relay':cfg['relay'],'rpcReady':False}))
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

#!/usr/bin/env python3
"""Prepare an exclusive owner-reviewed attachment bundle; never start anything.

Input hashes must come from the authenticated owner workflow. This tool verifies
bindings; it cannot authenticate the origin of arbitrary files supplied to it.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import time

spec=importlib.util.spec_from_file_location('storage_protocol',Path(__file__).with_name('storage_protocol.py'))
protocol=importlib.util.module_from_spec(spec);spec.loader.exec_module(protocol)


def directory(path):
    p=Path(path)
    if not p.is_absolute() or p.resolve(strict=True)!=p:raise ValueError('Canonical private owner directory required')
    for parent in [p,*p.parents]:
        s=parent.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid not in (0,os.geteuid()) or s.st_mode&0o022:raise ValueError('Directory authority mismatch')
    if stat.S_IMODE(p.stat().st_mode)!=0o700:raise ValueError('Private owner directory required')
    return p


def read_pinned(row):
    if set(row)!={'path','sha256'}:raise ValueError('Exact pinned input required')
    protocol.digest(row['sha256']);p=Path(row['path']);directory(p.parent)
    fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as f:
        s=os.fstat(f.fileno())
        if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.geteuid() or s.st_nlink!=1 or stat.S_IMODE(s.st_mode)!=0o600 or s.st_size>65536:
            raise ValueError('Protected bounded owner input required')
        raw=f.read(65537)
    if len(raw)>65536 or hashlib.sha256(raw).hexdigest()!=row['sha256']:raise ValueError('Owner input changed')
    return raw


def write_new(path,data):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())


def prepare(config):
    if set(config)!={'serverContract','serverReady','credentialReceipt','instance','guestBootId','output'}:
        raise ValueError('Exact owner preparation parameters required')
    start_wall=time.time_ns();start_mono=time.monotonic_ns()
    server=read_pinned(config['serverContract']);ready=read_pinned(config['serverReady']);credentials=read_pinned(config['credentialReceipt'])
    contract=protocol.compose(server,ready,credentials,config['guestBootId'],time.time_ns())
    if contract['instance']!=config['instance']:raise ValueError('Expected guest instance differs')
    def current():
        now=time.time_ns();elapsed=time.monotonic_ns()-start_mono
        if abs(now-start_wall-elapsed)>2_000_000_000 or elapsed>5_000_000_000:raise ValueError('Preparation clock/deadline bound')
        protocol.validate_attachment(contract,now,config['guestBootId'])
    current();output=Path(config['output']);directory(output.parent);output.mkdir(mode=0o700)
    raw=json.dumps(contract,sort_keys=True,indent=2).encode()+b'\n'
    write_new(output/'attachment.json',raw);write_new(output/'server-ready.json',ready)
    # Recheck original pinned inputs and time before publishing completion. A
    # failed partial directory remains consumed and is never silently reused.
    for field,expected in [('serverContract',server),('serverReady',ready),('credentialReceipt',credentials)]:
        if read_pinned(config[field])!=expected:raise ValueError('Owner input changed during preparation')
    current()
    result={'schema':'owned-rpc-attachment-bundle/1','attempt':contract['attempt'],'instance':contract['instance'],
        'guestBootId':contract['bootId'],'createdUtcNs':contract['createdUtcNs'],'deadlineUtcNs':contract['deadlineUtcNs'],
        'files':{'attachment.json':protocol.sha(raw),'server-ready.json':protocol.sha(ready)},
        'contractInputs':{key:config[key]['sha256'] for key in ['serverContract','serverReady','credentialReceipt']},
        'storageAttached':False,'rpcReady':False,'writersFenced':False}
    write_new(output/'RESULT.json',json.dumps(result,sort_keys=True,indent=2).encode()+b'\n')
    fd=os.open(output,os.O_DIRECTORY|os.O_RDONLY)
    try:os.fsync(fd)
    finally:os.close(fd)
    current()
    return result


if __name__=='__main__':
    import sys
    # Configuration includes only paths and public pins; private credentials are
    # never accepted on argv or copied into this bundle.
    print(json.dumps(prepare(protocol.decode(Path(sys.argv[1]).read_bytes()))))

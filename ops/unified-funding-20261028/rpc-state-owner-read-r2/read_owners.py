#!/usr/bin/env python3
"""Read selected ext4 ownership through a private, doubly read-only NBD view.

Caller must independently bound memory/lifetime and provide either isolated
namespaces or a private host directory with unit-owned unmount cleanup. Both NBD
ends are read-only. No ext4 filesystem mount or chain client is performed.
"""
import hashlib
import contextlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time


def run(argv, seconds=5):
    r=subprocess.run(argv,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=seconds)
    if len(r.stdout)+len(r.stderr)>65536:
        raise RuntimeError('Metadata output bound')
    if r.returncode:
        raise RuntimeError(json.dumps({'tool':argv[0],'exit':r.returncode,'stderr':r.stderr[:2048]}))
    return r.stdout,r.stderr


def identity(pid):
    try:
        raw=Path('/proc',str(pid),'stat').read_text()
        return raw[raw.rfind(')')+2:].split()[19]
    except FileNotFoundError:
        return None


def inspect(image, fmt, paths, expected_size, expected_uuid=None, write_refusal=False, workspace=None):
    if workspace is not None:
        workspace.mkdir(mode=0o700)
    with (tempfile.TemporaryDirectory(dir='/tmp') if workspace is None else contextlib.nullcontext(str(workspace))) as td:
        root=Path(td);mount=root/'view';mount.mkdir();pidfile=root/'ready'
        with (root/'fuse.txt').open('w+b') as log:
            proc=subprocess.Popen(['/usr/sbin/nbdfuse','-r','-s','-C','1','-P',str(pidfile),str(mount),'[','/usr/sbin/qemu-nbd','--read-only','--format='+fmt,str(image),']'],stdout=log,stderr=log)
            children={};mounted=False
            try:
                deadline=time.monotonic()+8
                while not pidfile.exists():
                    if proc.poll() is not None:
                        log.seek(0);raise RuntimeError('View startup: '+log.read(4096).decode(errors='replace'))
                    if time.monotonic()>=deadline:raise RuntimeError('View startup deadline')
                    time.sleep(.05)
                mounted=True
                if int(pidfile.read_text())!=proc.pid:raise RuntimeError('Unexpected view process')
                for child in Path('/proc',str(proc.pid),'task',str(proc.pid),'children').read_text().split():
                    children[int(child)]=identity(int(child))
                virtual=mount/'nbd'
                if virtual.stat().st_size!=expected_size:raise RuntimeError('Unexpected virtual volume size')
                refused=False
                if write_refusal:
                    try:
                        fd=os.open(virtual,os.O_WRONLY);os.close(fd)
                    except OSError:refused=True
                    if not refused:raise RuntimeError('Read-only fixture accepted writable open')
                with virtual.open('rb') as f:
                    f.seek(1024);superblock=f.read(1024)
                import uuid
                actual_uuid=str(uuid.UUID(bytes=superblock[104:120]))
                if superblock[56:58]!=b'\x53\xef' or expected_uuid and actual_uuid!=expected_uuid:
                    raise RuntimeError('Ext4 identity mismatch')
                owners={}
                for path in paths:
                    if not re.fullmatch(r'/[A-Za-z0-9_/-]+',path):raise ValueError('Fixed metadata path required')
                    out,err=run(['/usr/sbin/debugfs','-R','stat '+path,str(virtual)],10)
                    m=re.search(r'User:\s+(\d+)\s+Group:\s+(\d+)',out)
                    if not m or 'Type: directory' not in out:raise RuntimeError('Missing data directory: '+path+':'+err[:512])
                    owners[path]={'uid':int(m[1]),'gid':int(m[2]),'stat':out}
                result={'uuid':actual_uuid,'virtualBytes':expected_size,'owners':owners,'fixtureWritableOpenRefused':refused}
            finally:
                if mounted:
                    run(['/usr/sbin/fusermount3','-u',str(mount)],5)
                elif proc.poll() is None:
                    # No mount gate was reached. Namespace and caller deadline own cleanup.
                    proc.terminate()
                try:proc.wait(timeout=5)
                except subprocess.TimeoutExpired:proc.kill();proc.wait();raise
            if proc.returncode!=0:raise RuntimeError('View did not exit cleanly')
            if any(identity(pid)==start for pid,start in children.items() if start is not None):
                raise RuntimeError('Exact NBD child still present')
            result['viewExited']=True;result['exactChildrenGone']=True
            return result


def main(manifest):
    for name,row in manifest['tools'].items():
        with Path(name).open('rb') as f:
            if hashlib.file_digest(f,'sha256').hexdigest()!=row:raise RuntimeError('Tool pin changed')
    work=Path(manifest['workRoot']) if 'workRoot' in manifest else None
    if work is not None:
        work.mkdir(mode=0o700)
    before={}
    for row in manifest['inputs']:
        p=Path(row['path']);st=p.stat();values=[st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns]
        if p.is_symlink() or values!=row['identity']:raise RuntimeError('Input identity changed')
        before[str(p)]=values
    with tempfile.TemporaryDirectory(dir='/tmp') as td:
        raw=Path(td)/'fixture.raw'
        with raw.open('xb') as f:f.truncate(32*1024**2)
        run(['/usr/sbin/mke2fs','-q','-F','-t','ext4',str(raw)],10)
        fixture=inspect(raw,'raw',['/lost+found'],32*1024**2,write_refusal=True,workspace=work/'fixture' if work else None)
    result={'fixture':fixture,'volumes':{}}
    for row in manifest['volumes']:
        result['volumes'][row['role']]=inspect(Path(row['path']),'qcow2',row['paths'],row['bytes'],row['uuid'],workspace=work/row['role'] if work else None)
    for name,expected in before.items():
        st=Path(name).stat()
        if [st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns]!=expected:raise RuntimeError('Original image metadata changed')
    result.update(originalsUnchanged=True,readOnly=True,networkNamespace=work is None,privateHostView=work is not None,filesystemMounted=False)
    print(json.dumps(result))

if __name__=='__main__':
    import sys
    main(json.loads(Path(sys.argv[1]).read_text()))

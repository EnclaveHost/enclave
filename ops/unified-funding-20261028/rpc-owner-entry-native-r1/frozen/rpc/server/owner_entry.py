"""Fixed FD bootstrap for the finite storage-owner signer; no export start.

The user-systemd unit bounds setup before any key is opened. A private user
namespace maps the actual storage owner to uid0; it does not change ownership of
host files or grant host root. The journal is the sole writable mounted input.
"""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent


def clock_module():
    spec = importlib.util.spec_from_file_location('startup_clock', HERE.parent/'startup_clock.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def show(unit):
    fields = ['Id','MainPID','InvocationID','ControlGroup','Type','RuntimeMaxUSec',
              'TimeoutStopUSec','MemoryMax','MemorySwapMax','CPUQuotaPerSecUSec',
              'TasksMax','KillMode','Restart','SendSIGKILL','FinalKillSignal',
              'NoNewPrivileges','LimitCORE','ExecMainStartTimestampMonotonic']
    result = subprocess.run(['/usr/bin/systemctl','--user','show',unit,'--no-pager',
                             '--property='+','.join(fields)], capture_output=True, timeout=2, check=True)
    if len(result.stdout)+len(result.stderr)>16384: raise ValueError('Unit observation bound')
    lines = result.stdout.decode().splitlines()
    row = dict(line.split('=',1) for line in lines)
    if len(row)!=len(lines) or set(row)!=set(fields): raise ValueError('Exact unit observation required')
    return row


def envelope(attempt, original):
    unit = 'enclave-rpc-owner-sign-'+attempt+'.service'
    row = show(unit)
    expected = {'Id':unit,'MainPID':str(os.getpid()),'InvocationID':os.environ.get('INVOCATION_ID',''),
        'Type':'exec','RuntimeMaxUSec':'20s','TimeoutStopUSec':'1s','MemoryMax':str(128<<20),
        'MemorySwapMax':'0','CPUQuotaPerSecUSec':'1s','TasksMax':'32','KillMode':'control-group',
        'Restart':'no','SendSIGKILL':'yes','FinalKillSignal':'9','NoNewPrivileges':'yes','LimitCORE':'0'}
    if (not re.fullmatch('[0-9a-f]{32}',expected['InvocationID']) or any(row[k]!=v for k,v in expected.items())
            or Path('/proc/self/cgroup').read_text().strip()!='0::'+row['ControlGroup']):
        raise ValueError('Independent signer service differs')
    start = int(row['ExecMainStartTimestampMonotonic'])*1000
    if not 0<=time.monotonic_ns()-start<5_000_000_000 or start+21_000_000_000>=original['deadlineMonotonicNs']:
        raise ValueError('Independent signer cutoff does not fit original deadline')
    return row


def held(path, maximum, mode=0o600, wanted=None, directory=False):
    """Validate canonical owner namespace, pin the inode, and retain above fd20."""
    c=clock_module();path=Path(path)
    if path.resolve(strict=True)!=path:raise ValueError('Canonical owner input required')
    if mode==0o644:
        for parent in [path.parent,*path.parent.parents]:
            row=parent.lstat()
            if not stat.S_ISDIR(row.st_mode) or row.st_uid not in (0,os.geteuid()) or row.st_mode&0o022:raise ValueError('Source namespace differs')
    else:c.directory(path if directory else path.parent)
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|(os.O_DIRECTORY if directory else os.O_NONBLOCK))
    try:
        before=os.fstat(fd)
        if before.st_uid!=os.geteuid() or stat.S_IMODE(before.st_mode)!=mode:
            raise ValueError('Owner input identity/mode differs')
        if directory:
            if not stat.S_ISDIR(before.st_mode):raise ValueError('Owner journal must be a directory')
        else:
            if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or not 0<before.st_size<=maximum:
                raise ValueError('Bounded single-link regular owner input required')
            if wanted is not None:
                c.protocol.digest(wanted)
                h=hashlib.sha256()
                while data:=os.read(fd,65536):h.update(data)
                if h.hexdigest()!=wanted:raise ValueError('Pinned owner input changed')
                after=os.fstat(fd)
                if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns):raise ValueError('Owner input changed during hashing')
                os.lseek(fd,0,os.SEEK_SET)
        return fcntl.fcntl(fd,fcntl.F_DUPFD_CLOEXEC,20)
    finally:os.close(fd)


def inside():
    # This branch sees only fixed mount names. It does not parse untrusted paths
    # or instantiate a new deadline. The unchanged Go actor validates every FD.
    names=['policy','journal','l1-seed','base-seed','contract','clock']
    fds=[]
    try:
        for name in names:
            fd=os.open('/owner/'+name,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
            fds.append(fcntl.fcntl(fd,fcntl.F_DUPFD_CLOEXEC,20));os.close(fd)
        for target,fd in enumerate(fds,3):os.dup2(fd,target,inheritable=True)
        for fd in fds:os.close(fd)
        fds=[]
        os.execv('/owner/issuer',['rpc-storage-owner'])
    finally:
        for fd in fds:os.close(fd)


def main(path):
    os.umask(0o077)
    c=clock_module();raw=c.read(path);config=c.protocol.decode(raw)
    fields={'schema','attempt','clock','contract','policy','journal','seeds','binary','pins','receipt'}
    if set(config)!=fields or config['schema']!='enclave-rpc-owner-entry/1':raise ValueError('Exact signer bootstrap configuration required')
    original=c.validate(config['clock'])
    if config['attempt']!=original['attempt']:raise ValueError('Original attempt differs')
    envelope(config['attempt'],original)
    required={str(HERE/'owner_entry.py'),str(HERE.parent/'startup_clock.py'),str(HERE.parent/'storage_protocol.py'),'/usr/bin/bwrap','/usr/bin/python3'}
    if set(config['pins'])!=required:raise ValueError('Exact signer bootstrap closure required')
    for name,wanted in config['pins'].items():
        c.protocol.digest(wanted)
        with open(name,'rb') as f:
            if hashlib.file_digest(f,'sha256').hexdigest()!=wanted:raise ValueError('Signer bootstrap source changed')
    if type(config['seeds']) is not list or len(config['seeds'])!=2:raise ValueError('Two owner seed paths required')
    contract=c.protocol.decode(c.read_pinned(config['contract']))
    if contract['startupClock']!=config['clock'] or contract['attempt']!=original['attempt']:raise ValueError('Exact original export contract required')
    policy=c.protocol.decode(c.read_pinned(config['policy']))
    if policy['export']['contractSha256']!=config['contract']['sha256']:raise ValueError('Policy export contract differs')
    receipt=Path(config['receipt']);c.directory(receipt.parent)
    if receipt.name!='signer-started.json':raise ValueError('Fixed signer receipt required')
    identity=envelope(config['attempt'],original)
    c.write_new(receipt,c.encode({'schema':'enclave-rpc-owner-sign-started/1','attempt':original['attempt'],
        'clock':config['clock'],'contract':config['contract'],'binary':config['binary'],
        'unit':identity,'rpcReady':False,'writersFenced':False}))
    fds=[]
    try:
        for key in ('policy','contract','clock'):
            b=config[key];fds.append((key,held(b['path'],65536,wanted=b['sha256']),False))
        fds.append(('journal',held(config['journal'],0,0o700,directory=True),True))
        for name,path in zip(('l1-seed','base-seed'),config['seeds']):fds.append((name,held(path,32),False))
        b=config['binary'];fds.append(('issuer',held(b['path'],64<<20,0o700,wanted=b['sha256']),False))
        # The source file is mounted by a held/pinned descriptor too. An outer
        # path replacement cannot substitute an unreviewed inner bootstrap.
        fds.append(('entry.py',held(str(HERE/'owner_entry.py'),65536,0o644,wanted=config['pins'][str(HERE/'owner_entry.py')]),False))
        c.validate(config['clock']);envelope(config['attempt'],original)
        args=['/usr/bin/bwrap','--unshare-user','--uid','0','--gid','0','--die-with-parent',
              '--ro-bind','/','/','--tmpfs','/owner','--clearenv','--setenv','PATH','/usr/bin:/bin',
              '--setenv','GOMAXPROCS','1','--setenv','HOME','/owner']
        for name,fd,writable in fds:
            os.set_inheritable(fd,True)
            args += ['--bind-fd' if writable else '--ro-bind-fd',str(fd),'/owner/'+name]
        args += ['/usr/bin/python3','-I','/owner/entry.py','--inside']
        os.execv(args[0],args)
    finally:
        for _,fd,_ in fds:os.close(fd)


if __name__=='__main__':
    if sys.argv[1:]==['--inside']:inside()
    elif len(sys.argv)==2:main(sys.argv[1])
    else:raise SystemExit('One protected signer configuration required')

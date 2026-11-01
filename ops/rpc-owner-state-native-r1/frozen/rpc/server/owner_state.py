"""One-time storage-owner state; no chain commitment, export or writer grant.

The owner selects the protected parent and original volume identities. The fixed
authority directory is exclusively created and NEVER reset after partial work.
Its descriptor binds keys, original chains and the one persistent journal. A
consumer must still authenticate these public keys in the owner's chain policy.
"""
import hashlib
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

HERE=Path(__file__).resolve().parent


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m


c=load('owner_state_clock',HERE.parent/'startup_clock.py')
v=load('owner_state_volume',HERE/'volume_export.py')


def identity(s):
    return [s.st_dev,s.st_ino]


def file_identity(s):
    return [s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns]


def open_directory(path,expected):
    if type(expected) is not list or len(expected)!=2 or any(type(n) is not int or n<0 for n in expected):raise ValueError('Exact owner directory pin required')
    path=c.directory(path)
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        s=os.fstat(fd)
        if s.st_uid!=os.geteuid() or stat.S_IMODE(s.st_mode)!=0o700 or identity(s)!=expected:
            raise ValueError('Original owner directory identity changed')
        return fd
    except BaseException:os.close(fd);raise


def validate_sources(roles):
    if not isinstance(roles,dict) or set(roles)!={'l1','base'}:raise ValueError('Two explicit owner volumes required')
    names=set();sources=set()
    for role in ('l1','base'):
        value=roles[role]
        if set(value)!={'volumeId','originals'}:raise ValueError('Exact original volume binding required')
        c.protocol.digest(value['volumeId'])
        if value['volumeId']=='0'*64 or value['volumeId'] in names:raise ValueError('Distinct nonzero logical volumes required')
        names.add(value['volumeId'])
        if type(value['originals']) is not list or not 1<=len(value['originals'])<=3:raise ValueError('Bounded original chain required')
        for row in value['originals']:
            if type(row) is not list or len(row)!=2 or type(row[1]) is not list or len(row[1])!=5:raise ValueError('Original identity required')
            path=Path(row[0]);v.directory(path.parent)
            if not path.is_absolute() or path.resolve(strict=True)!=path:raise ValueError('Canonical original required')
            if any(type(n) is not int or n<0 for n in row[1]):raise ValueError('Exact native source identity required')
            fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK)
            try:
                s=os.fstat(fd)
                if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_uid not in (0,os.geteuid()) or s.st_mode&0o022 or file_identity(s)!=row[1] or v.metadata(path)!=row[1]:
                    raise ValueError('Original volume identity changed')
                source=(s.st_dev,s.st_ino)
                if source in sources:raise ValueError('Original image aliases another role or chain entry')
                sources.add(source)
            finally:os.close(fd)


def inspect(binding,contract,policy):
    """Validate public state and return fixed paths; this does not open seeds."""
    raw=c.read_pinned(binding);d=c.protocol.decode(raw);root=Path(binding['path']).parent
    if Path(binding['path']).name!='authority.json' or root.name!='authority':raise ValueError('Fixed owner state namespace required')
    if set(d)!={'schema','root','parent','journal','roles','keys','provisionAttempt'} or d['schema']!='enclave-rpc-owner-state/1':raise ValueError('Exact owner state descriptor required')
    if not re.fullmatch('[0-9a-f]{32}',d['provisionAttempt']):raise ValueError('Original provisioning attempt required')
    for p,pin in ((root,d['root']),(root.parent,d['parent'])):
        fd=open_directory(p,pin);os.close(fd)
    validate_sources(d['roles'])
    if set(d['keys'])!={'l1','base'}:raise ValueError('Exact owner key pair required')
    for role,key in d['keys'].items():
        if set(key)!={'identity','publicKey'} or len(key['identity'])!=5:raise ValueError('Owner key identity required')
        c.protocol.digest(key['publicKey'])
        if key['publicKey']=='0'*64:raise ValueError('Nonzero owner public key required')
        if policy[role+'Volume']!=d['roles'][role]['volumeId'] or contract['roles'][role]['originals']!=d['roles'][role]['originals']:
            raise ValueError('Provisioned owner volume/export mapping differs')
    fd=open_directory(root/'journal',d['journal']);os.close(fd)
    if c.read_pinned(binding)!=raw:raise ValueError('Owner state descriptor changed')
    return d


def bind(binding,contract,policy):
    """Retain the provisioned journal and key inodes, never caller-selected ones."""
    d=inspect(binding,contract,policy);root=Path(binding['path']).parent;out=[]
    try:
        def retain(fd):
            try:return fcntl.fcntl(fd,fcntl.F_DUPFD_CLOEXEC,20)
            finally:os.close(fd)
        out.append(('journal',retain(open_directory(root/'journal',d['journal'])),True))
        for role in ('l1','base'):
            fd=retain(os.open(root/(role+'-seed'),os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK))
            out.append((role+'-seed',fd,False));s=os.fstat(fd)
            if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.geteuid() or s.st_nlink!=1 or stat.S_IMODE(s.st_mode)!=0o600 or s.st_size!=32 or file_identity(s)!=d['keys'][role]['identity']:
                raise ValueError('Provisioned owner key was replaced or changed')
        # Recheck both the namespace and held inodes after acquisition. Journal
        # contents are deliberately not required empty: consumed records survive.
        inspect(binding,contract,policy)
        return out
    except BaseException:
        for _,fd,_ in out:os.close(fd)
        raise


def provision(config):
    fields={'schema','attempt','clock','parent','roles','resourceConfig','pins'}
    if set(config)!=fields or config['schema']!='enclave-rpc-owner-provision/1':raise ValueError('Exact provisioning contract required')
    original=c.validate(config['clock'])
    if config['attempt']!=original['attempt']:raise ValueError('Original provisioning attempt differs')
    e=load('owner_state_entry',HERE/'owner_entry.py');e.envelope(config['attempt'],original,'provision')
    required={str(HERE/n) for n in ('owner_state.py','owner_entry.py','volume_export.py','observe_resources.mjs')}
    required|={str(HERE.parent/n) for n in ('startup_clock.py','storage_protocol.py')}
    required|={'/usr/bin/python3','/usr/bin/node','/usr/bin/openssl','/usr/bin/stat',config['resourceConfig']['path']}
    if set(config['pins'])!=required:raise ValueError('Pinned provisioning closure required')
    for name,wanted in config['pins'].items():
        c.protocol.digest(wanted)
        with open(name,'rb') as f:
            if hashlib.file_digest(f,'sha256').hexdigest()!=wanted:raise ValueError('Provisioning pin changed')
    c.read_pinned(config['resourceConfig'])
    r=subprocess.run(['/usr/bin/node',str(HERE/'observe_resources.mjs'),config['resourceConfig']['path']],capture_output=True,timeout=3,check=True)
    if len(r.stdout)+len(r.stderr)>65536:raise ValueError('Resource observation bound')
    a=c.protocol.decode(r.stdout)
    if (a.get('authenticated') is not True or a.get('unreadUnits')!=0 or any(type(a.get(k)) is not int or a[k]<0 for k in ('availableMiB','pendingMiB','floorMiB'))
            or a['availableMiB']-a['pendingMiB']-384<max(27648,a['floorMiB'])):raise ValueError('Provisioning capacity refused')
    if set(config['parent'])!={'path','identity'}:raise ValueError('Pinned owner parent required')
    parent=Path(config['parent']['path']);pfd=open_directory(parent,config['parent']['identity']);root=parent/'authority'
    try:
        validate_sources(config['roles']);c.validate(config['clock']);e.envelope(config['attempt'],original,'provision')
        # This mkdir is the permanent consumed setup gate. Never delete it even
        # if key generation or any later fsync fails. No alternate suffix/retry.
        os.mkdir('authority',0o700,dir_fd=pfd);os.fsync(pfd)
        rfd=os.open('authority',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=pfd)
        try:
            fs=subprocess.run(['/usr/bin/stat','-f','-c','%t','/proc/self/fd/'+str(rfd)],pass_fds=(rfd,),capture_output=True,timeout=2,check=True)
            if fs.stdout.strip()!=b'ef53':raise ValueError('Persistent ext4 owner state required')
            c.write_new(root/'provision.intent',c.encode({'attempt':original['attempt'],'clock':config['clock'],'roles':config['roles'],'unit':e.envelope(config['attempt'],original,'provision')}))
            os.mkdir('journal',0o700,dir_fd=rfd);os.fsync(rfd)
            keys={}
            for role in ('l1','base'):
                seed=bytearray(os.urandom(32))
                try:
                    # Fixed PKCS8 Ed25519 seed wrapper; only the public SPKI is
                    # returned. No private material enters argv, logs or stdout.
                    public=subprocess.run(['/usr/bin/openssl','pkey','-inform','DER','-pubout','-outform','DER'],input=bytes.fromhex('302e020100300506032b657004220420')+seed,capture_output=True,timeout=2,check=True,env={'PATH':'/usr/bin:/bin','OPENSSL_CONF':'/dev/null'}).stdout
                    if len(public)!=44 or public[:12]!=bytes.fromhex('302a300506032b6570032100'):raise ValueError('Exact Ed25519 public key required')
                    if any(k['publicKey']==public[12:].hex() for k in keys.values()):raise ValueError('Distinct owner role keys required')
                    c.write_new(root/(role+'-seed'),seed)
                    keys[role]={'publicKey':public[12:].hex(),'identity':file_identity((root/(role+'-seed')).lstat())}
                finally:seed[:]=b'\0'*len(seed)
            validate_sources(config['roles']);c.validate(config['clock']);e.envelope(config['attempt'],original,'provision')
            check=open_directory(parent,config['parent']['identity']);os.close(check)
            if identity(root.lstat())!=identity(os.fstat(rfd)):raise ValueError('Owner root namespace changed')
            descriptor={'schema':'enclave-rpc-owner-state/1','root':identity(os.fstat(rfd)),'parent':identity(os.fstat(pfd)),
                'journal':identity((root/'journal').lstat()),'roles':config['roles'],'keys':keys,'provisionAttempt':original['attempt']}
            binding=c.write_new(root/'authority.json',c.encode(descriptor))
            return {'schema':'enclave-rpc-owner-provisioned/1','authority':binding,
                'rpcStorage':{'schema':'enclave-rpc-storage-authorities/1',**{role:{'volumeId':config['roles'][role]['volumeId'],'publicKey':keys[role]['publicKey']} for role in ('l1','base')}},
                'ownerCommitmentVerified':False,'rpcReady':False,'reservationMayRelease':False}
        finally:os.close(rfd)
    finally:os.close(pfd)


if __name__=='__main__':
    os.umask(0o077)
    if len(sys.argv)!=2:raise SystemExit('One protected provisioning contract required')
    print(json.dumps(provision(c.protocol.decode(c.read(sys.argv[1]))),sort_keys=True),flush=True)

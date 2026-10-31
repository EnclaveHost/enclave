from pathlib import Path
import base64,hashlib,json,os,stat,sys

root=Path('/home/controladmin/rpc-private-guest-8ee4452b174746c2b606b9b68f0fa623/8ee4452b174746c2b606b9b68f0fa623')
receipt_sha='031225948e5f62d553d703c001ac172ce21aa30668f3acc67e52f17054324c43'
def directory(p):
    assert p.is_absolute() and p.resolve(strict=True)==p
    for q in [p,*p.parents]:
        s=q.lstat();assert stat.S_ISDIR(s.st_mode) and s.st_uid in (0,os.geteuid()) and not s.st_mode&0o022
    assert stat.S_IMODE(p.stat().st_mode)==0o700
def identity(s):return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
def read(p):
    directory(p.parent)
    fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as f:
        s=os.fstat(f.fileno())
        assert stat.S_ISREG(s.st_mode) and s.st_uid==os.geteuid() and stat.S_IMODE(s.st_mode)==0o600 and s.st_nlink==1 and 0<s.st_size<=16384
        data=f.read(16385);after=os.fstat(f.fileno())
        assert identity(s)==identity(after) and len(data)==s.st_size and identity(p.stat())==identity(s)
    return data,identity(s)
mem=next(int(x.split()[1])//1024 for x in Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:'))
assert mem>=2048+128
directory(root)
names=['PUBLIC.json']+[role+'/'+kind+'/'+name for role in ('l1','base') for kind in ('server','client') for name in ('ca-cert.pem',kind+'-cert.pem',kind+'-key.pem')]
files={};identities={}
for name in names:
    data,s=read(root/name);files[name]=data;identities[name]=s
assert hashlib.sha256(files['PUBLIC.json']).hexdigest()==receipt_sha
public=json.loads(files['PUBLIC.json'])
assert public['attempt']==root.name and public['instance']=='rpc-owned-'+root.name and set(public['roles'])=={'l1','base'}
for role in ('l1','base'):
    row=public['roles'][role]
    for kind in ('client','server'):
        assert hashlib.sha256(files[role+'/'+kind+'/ca-cert.pem']).hexdigest()==row['caSha256']
        assert hashlib.sha256(files[role+'/'+kind+'/'+kind+'-cert.pem']).hexdigest()==row[kind+'CertificateSha256']
for name in names:
    data,s=read(root/name);assert data==files[name] and s==identities[name]
payload={'files':{name:base64.b64encode(data).decode() for name,data in files.items()},'invocation':os.environ['INVOCATION_ID'],'bootId':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'availableMiB':mem,'originalsUnchanged':True,'pid':os.getpid(),'processStart':Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19]}
encoded=json.dumps(payload).encode();assert len(encoded)<65536
# This stdout is a private SSH transport stream. The receiver must never log it.
sys.stdout.buffer.write(encoded)

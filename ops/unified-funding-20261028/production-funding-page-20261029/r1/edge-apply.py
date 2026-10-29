"""One fresh additive website release: preserve base tree, verify all bytes, CAS only two apex roots.
No payments, old-tree writes, unrelated configuration changes, or automatic retries.
"""
import sys,json,os,pathlib,hashlib,stat,subprocess,base64,http.client,socket,shutil,fcntl
v=json.load(sys.stdin)
assert os.geteuid()==0
sha=lambda b:hashlib.sha256(b).hexdigest()
old='/opt/enclave-site/'+v['baseCid']+'/site';new='/opt/enclave-site/'+v['cid']+'/site'
cfg=pathlib.Path('/etc/enclave-bootstrap-tls/Caddyfile')
before=v['before'];after=v['candidate'];diskBefore=v['beforeText'].encode();diskAfter=v['candidateText'].encode()
def diff(a,b,p=''):
    if type(a)!=type(b):return[p]
    if isinstance(a,dict):
        assert set(a)==set(b)
        return sum((diff(a[k],b[k],p+'/'+k) for k in a),[])
    if isinstance(a,list):
        assert len(a)==len(b)
        return sum((diff(x,y,p+'/'+str(i)) for i,(x,y) in enumerate(zip(a,b))),[])
    if a!=b:assert a==old and b==new;return[p]
    return[]
assert sorted(diff(before,after))==sorted('/'+p for p in v['changedPaths']) and len(v['changedPaths'])==2
class UnixHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(20)
        self.sock.connect('/run/enclave-bootstrap-tls/admin.sock')
def api(method='GET',body=None,etag=None):
    c=UnixHTTP('localhost',timeout=20);h={'Content-Type':'application/json'}
    if etag:h['If-Match']=etag
    try:
        c.request(method,'/config/',None if body is None else json.dumps(body),h)
        r=c.getresponse();data=r.read(2_000_001);assert len(data)<=2_000_000
        assert r.status==200,('caddy status',r.status)
        return (json.loads(data) if data else None),r.getheader('ETag')
    finally:c.close()
def syncdir(p):
    fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)
def save(p,data,mode=0o600):
    p=pathlib.Path(p)
    with p.open('xb') as f:f.write(data);f.flush();os.fsync(f.fileno())
    os.chmod(p,mode);syncdir(str(p.parent))
live,etag=api();assert live==before and etag
assert cfg.read_bytes()==diskBefore and not cfg.is_symlink()
root=pathlib.Path('/opt/enclave-site')/v['cid'];assert not root.exists()
assert os.statvfs(root.parent).f_bavail*os.statvfs(root.parent).f_frsize>1024**3
op=pathlib.Path('/var/lib/enclave-funding-site-20261029-r1');op.mkdir(mode=0o700)
lock=os.open(op/'lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
save(op/'before.json',json.dumps(before).encode());save(op/'candidate.json',json.dumps(after).encode())
save(op/'before.Caddyfile',diskBefore);save(op/'candidate.Caddyfile',diskAfter)
root.mkdir(mode=0o755)
subprocess.run(['cp','-a','--reflink=auto',old,str(root/'site')],check=True,timeout=90)
for name,content in v['additions'].items():
    assert not name.startswith('/') and '..' not in pathlib.PurePosixPath(name).parts
    p=root/'site'/name;assert not os.path.lexists(p)
    p.parent.mkdir(parents=True,exist_ok=True);save(p,base64.b64decode(content),0o644)
found={}
for d,dirs,files in os.walk(root/'site',followlinks=False):
    os.chmod(d,0o755)
    for n in dirs+files:assert not pathlib.Path(d,n).is_symlink()
    for n in files:
        p=pathlib.Path(d,n);assert p.is_file()
        os.chmod(p,0o644);found[str(p.relative_to(root/'site'))]=sha(p.read_bytes())
assert found==v['files'] and len(found)==1131
save(root/'composite-provenance.json',v['provenance'].encode(),0o644)
r=subprocess.run(['/usr/local/lib/enclave-caddy/caddy','validate','--config',str(op/'candidate.json')],capture_output=True,timeout=40)
assert r.returncode==0,'candidate validation failed'
live,etag=api();assert live==before and etag and cfg.read_bytes()==diskBefore
save(op/'intent.json',json.dumps({'phase':'patch-requested','cid':v['cid'],'beforeSha256':sha(diskBefore),'afterSha256':sha(diskAfter),'etag':etag}).encode())
api('PATCH',after,etag)
assert api()[0]==after
tmp=cfg.with_name('Caddyfile.funding-live-page-r1.tmp');st=cfg.stat()
save(tmp,diskAfter,stat.S_IMODE(st.st_mode));os.chown(tmp,st.st_uid,st.st_gid)
assert cfg.read_bytes()==diskBefore
os.replace(tmp,cfg);syncdir(str(cfg.parent))
r=subprocess.run(['/usr/local/lib/enclave-caddy/caddy','adapt','--config',str(cfg),'--adapter','caddyfile'],capture_output=True,timeout=30)
assert r.returncode==0 and json.loads(r.stdout)==after and api()[0]==after
result={'phase':'apex-switched','cid':v['cid'],'verifiedFiles':len(found),'changedRoots':2,'oldTreePreserved':True,'configSha256':sha(diskAfter),'signingEnabled':False}
save(op/'result.json',json.dumps(result).encode());print(json.dumps(result))

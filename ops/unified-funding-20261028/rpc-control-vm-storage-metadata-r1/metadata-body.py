# PREPARED ONLY. Appended after the previously reviewed bounded capture helper.
import json, pathlib, platform, re, resource, shutil, hashlib, sys
from urllib.parse import urlsplit, urlunsplit
P = pathlib.Path
resource.setrlimit(resource.RLIMIT_AS, (384 << 20, 384 << 20))
resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
deadline = time.monotonic() + 32
out = {'readOnly': True, 'installAdmitted': False, 'errors': []}
def read(p, limit=65536):
    with open(p, 'rb') as f: b=f.read(limit+1)
    if len(b)>limit: raise ValueError('input-size-limit')
    return b.decode('utf-8', 'replace')
def public_uri(m):
    try:
        u=urlsplit(m.group(0)); host=u.hostname or ''
        if u.port: host+=':'+str(u.port)
        return urlunsplit((u.scheme,host,u.path,'',''))
    except Exception: return '[redacted-uri]'
def sanitize(s):
    return re.sub(r'(?:https?|ftp)://[^\s<>]+',public_uri,s)
def command(name, argv, seconds=4, limit=262144, allow_nonzero=False):
    remaining=deadline-time.monotonic()
    if remaining<=0: raise TimeoutError('metadata-deadline')
    r=capture(argv,min(seconds,remaining),limit=limit)
    r['stdout']=sanitize(r['stdout']);r['stderr']=sanitize(r['stderr'])
    out[name]=r
    if r['reason'] or (r['rc'] and not allow_nonzero): out['errors'].append('incomplete:'+name)
    return r
try:
    out['identity']={'hostname':platform.node(),'kernel':platform.release(),
                     'bootId':read('/proc/sys/kernel/random/boot_id').strip()}
    assert out['identity']['hostname']=='enclave-control'
    assert out['identity']['bootId']=='b39ecfe2-82b2-4c2a-a596-a52630bb59fd'
    available=next(int(l.split()[1]) for l in read('/proc/meminfo').splitlines() if l.startswith('MemAvailable:'))
    assert available>=5632*1024
    out['memAvailableKiB']=available
    out['osRelease']={}
    for line in read('/etc/os-release').splitlines():
        k,sep,v=line.partition('=')
        if sep and k in ('ID','VERSION_ID','VERSION_CODENAME','UBUNTU_CODENAME'): out['osRelease'][k]=v.strip('"')
    command('architecture',['/usr/bin/dpkg','--print-architecture'])
    # No auth.conf, private keys, process environment, or unrestricted apt configuration dump.
    paths=[P('/etc/apt/sources.list')]+sorted(P('/etc/apt/sources.list.d').glob('*.sources'))+sorted(P('/etc/apt/sources.list.d').glob('*.list'))
    assert len(paths)<=24
    out['sources']=[]
    for p in paths:
        if not p.is_file(): continue
        raw=read(p); lines=[]
        for line in raw.splitlines():
            s=line.strip()
            if s.startswith(('deb ','deb-src ')) or re.match(r'^(Types|URIs|Suites|Components|Signed-By|Enabled|Trusted|Check-Valid-Until):',s): lines.append(sanitize(s))
        out['sources'].append({'path':str(p),'sha256':hashlib.sha256(raw.encode()).hexdigest(),'fields':lines})
    # Empty pkgcache paths prevent apt-cache from rebuilding on-disk caches.
    opts=['-o','Dir::Cache::pkgcache=','-o','Dir::Cache::srcpkgcache=']
    command('candidatePolicy',['/usr/bin/apt-cache',*opts,'policy','nbd-client'])
    deps=command('dependencies',['/usr/bin/apt-cache',*opts,'depends','--recurse','--no-recommends','--no-suggests','--no-conflicts','--no-breaks','--no-replaces','--no-enhances','nbd-client'],5,65536)
    packages={'nbd-client'}
    if deps['rc']==0 and not deps['reason']:
        for line in deps['stdout'].splitlines():
            if re.fullmatch(r'[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?',line): packages.add(line)
    assert len(packages)<=32
    out['packageNames']=sorted(packages)
    command('candidateRecords',['/usr/bin/apt-cache',*opts,'show','--no-all-versions',*sorted(packages)],5)
    command('installedVersions',['/usr/bin/dpkg-query','-W','-f=${binary:Package}\t${Version}\t${Architecture}\t${db:Status-Abbrev}\n',*sorted(packages)],3,65536,True)
    command('simulatedInstall',['/usr/bin/apt-get',*opts,'-s','-o','Debug::NoLocking=1','--no-install-recommends','--no-upgrade','install','nbd-client'],5,131072)
    command('indexTargets',['/usr/bin/apt-get',*opts,'indextargets','--format','$(IDENTIFIER)\t$(ORIGIN)\t$(SUITE)\t$(CODENAME)\t$(ARCHITECTURE)\t$(TRUSTED)\t$(FILENAME)\t$(URI)'],3,65536)
    out['releaseFiles']=[]
    files=sorted(P('/var/lib/apt/lists').glob('*InRelease'))+sorted(P('/var/lib/apt/lists').glob('*_Release'))+sorted(P('/var/lib/apt/lists').glob('*_Release.gpg'))
    assert len(files)<=24
    for p in files:
        assert time.monotonic()<deadline
        st=p.stat(); assert st.st_size<=4<<20
        with p.open('rb') as f: h=hashlib.file_digest(f,'sha256').hexdigest()
        out['releaseFiles'].append({'path':str(p),'bytes':st.st_size,'mtimeNs':st.st_mtime_ns,'sha256':h})
    out['tools']={}
    for n in ('dpkg-deb','gpgv','readelf','ldconfig','mke2fs','e2fsck','blkid','modprobe','nbd-client','timeout','python3','ssh'):
        found=shutil.which(n)
        if not found: out['tools'][n]=None;continue
        p=P(found).resolve(); st=p.stat()
        assert st.st_size<=32<<20
        with p.open('rb') as f: h=hashlib.file_digest(f,'sha256').hexdigest()
        out['tools'][n]={'path':found,'realpath':str(p),'bytes':st.st_size,'sha256':h}
    out['ubuntuArchiveKeyring']=None
    p=P('/usr/share/keyrings/ubuntu-archive-keyring.gpg')
    if p.is_file():
        assert p.stat().st_size<=1<<20
        with p.open('rb') as f: h=hashlib.file_digest(f,'sha256').hexdigest()
        out['ubuntuArchiveKeyring']={'path':str(p),'bytes':p.stat().st_size,'sha256':h}
except Exception as e:
    out['errors'].append(type(e).__name__)
out['complete']=not out['errors']
out['signatureChainVerified']=False
out['runtimeDependenciesVerified']=False
out['note']='Cached metadata only; no apt update, download, install, export, mount, or client start. Nonzero dpkg-query is retained for missing packages. No admission or fresh signature verification.'
print(json.dumps(out,sort_keys=True))
sys.exit(0 if out['complete'] else 2)

# PREPARED ONLY. Root admission required. No NBD attach/module load is present.
import json, pathlib, resource, hashlib, sys, io, tarfile, stat, re, platform
import urllib.request, email.utils, datetime, struct
P=pathlib.Path
resource.setrlimit(resource.RLIMIT_AS,(384<<20,384<<20))
resource.setrlimit(resource.RLIMIT_CPU,(30,30))
resource.setrlimit(resource.RLIMIT_FSIZE,(4<<20,4<<20))
os.umask(0o077)
out={'status':'INCOMPLETE_NOT_USABLE','errors':[],'moduleLoaded':False,'deviceAttached':False,'systemPackagesChanged':False}
deadline=time.monotonic()+70
dest=P('/home/controladmin/rpc-nbd-tools-20261030-r1')
manifest=json.loads(MANIFEST_JSON)
def digest(p):
    with P(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def read(p,limit):
    with P(p).open('rb') as f:b=f.read(limit+1)
    assert len(b)<=limit,'read-size-limit'
    return b
def command(name,args,seconds=5,limit=65536,binary=False, ok_rc=(0,)):
    assert time.monotonic()<deadline,'deadline'
    r=capture(args,min(seconds,deadline-time.monotonic()),limit=limit)
    if r['rc'] not in ok_rc or r['reason'] or r['truncated']:
        r.pop('stdoutBytes',None);out[name]=r;raise RuntimeError(name+':command-failed')
    if binary:
        b=r.pop('stdoutBytes');r['stdout']='[binary omitted]';out[name]=r;return b
    r.pop('stdoutBytes',None);out[name]=r;return r['stdout']+r['stderr']
def paragraph(raw):
    d={}
    for line in raw.splitlines():
        if not line or line[0].isspace():continue
        k,sep,v=line.partition(':')
        if sep:d[k]=v.strip()
    return d
def pin_file(row):
    p=P(row['path']);assert p.stat().st_size==row['bytes'] and digest(p)==row['sha256'],'input-drift'
def owned_library(path):
    p=P(path).resolve(strict=True);s=p.stat()
    assert str(p).startswith('/usr/lib/x86_64-linux-gnu/') and s.st_uid==0 and not(s.st_mode&0o022),'library-path-mode'
    aliases=[str(p),str(p).removeprefix('/usr')]
    aliases=[a for a in aliases if P(a).resolve(strict=True)==p and P(a).stat().st_dev==s.st_dev and P(a).stat().st_ino==s.st_ino]
    ownership=command('owner:'+p.name,['/usr/bin/dpkg-query','-S',*aliases],2,ok_rc=(0,1))
    owners=set()
    for line in ownership.splitlines():
        for a in aliases:
            if line.endswith(': '+a):owners.add(line[:-(len(a)+2)])
    assert len(owners)==1,'library-owner'
    package=owners.pop()
    assert package in manifest['installedVersions'],'unobserved-library-package'
    current=command('version:'+package,['/usr/bin/dpkg-query','-W','-f=${Version}\t${db:Status-Abbrev}',package],2)
    assert current==manifest['installedVersions'][package]+'\tii ','installed-version-drift'
    sums=read('/var/lib/dpkg/info/'+package+'.md5sums',2<<20).decode()
    matches=[l.split()[0] for l in sums.splitlines() if len(l.split())==2 and l.split()[1] in {a.lstrip('/') for a in aliases}]
    assert matches and len(set(matches))==1,'package-file-digest-missing-or-ambiguous'
    with p.open('rb') as f:md5=hashlib.file_digest(f,'md5').hexdigest()
    assert md5==matches[0],'installed-file-drift'
    return {'path':str(p),'bytes':s.st_size,'sha256':digest(p),'package':package,'version':manifest['installedVersions'][package],'installedMd5Matched':True}
try:
    assert platform.node()=='enclave-control'
    assert read('/proc/sys/kernel/random/boot_id',128).decode().strip()==manifest['bootId']
    available=next(int(l.split()[1]) for l in read('/proc/meminfo',16384).decode().splitlines() if l.startswith('MemAvailable:'))
    assert available>=5632*1024,'memory-floor'
    for row in manifest['remotePins']:pin_file(row)
    assert dest.parent.is_dir() and dest.parent.stat().st_uid==os.getuid()
    dest.mkdir(mode=0o700)  # Exclusive; never reuse or overwrite a prior attempt.
    out['privateDirectory']=str(dest)
    release=manifest['release']['path'];pin_file(manifest['release'])
    signature=command('releaseSignature',['/usr/bin/gpgv','--keyring',manifest['keyring']['path'],'--status-fd','1',release])
    assert '[GNUPG:] VALIDSIG ' in signature and not any(x in signature for x in ('BADSIG','ERRSIG','REVKEYSIG','EXPKEYSIG','EXPSIG'))
    signed=read(release,1<<20).decode()
    clear=signed.split('\n\n',1)[1].split('-----BEGIN PGP SIGNATURE-----',1)[0]
    clear='\n'.join(l[2:] if l.startswith('- ') else l for l in clear.splitlines())
    fields=paragraph(clear)
    assert fields['Origin']=='Ubuntu' and fields['Suite']=='noble-updates' and fields['Codename']=='noble'
    issued=email.utils.parsedate_to_datetime(fields['Date']).timestamp();now=time.time()
    assert now-7*86400<=issued<=now+3600,'release-age'
    if 'Valid-Until' in fields:assert now<=email.utils.parsedate_to_datetime(fields['Valid-Until']).timestamp(),'expired-release'
    hashes=clear.split('\nSHA256:\n',1)[1].split('\nSHA512:',1)[0]
    entries=[l.split() for l in hashes.splitlines() if len(l.split())==3 and l.split()[2]=='universe/binary-amd64/Packages']
    assert len(entries)==1,'signed-index-entry'
    expected_hash,expected_size,_=entries[0];expected_size=int(expected_size)
    assert 0<expected_size<=64<<20
    index=P('/var/lib/apt/lists/archive.ubuntu.com_ubuntu_dists_noble-updates_universe_binary-amd64_Packages')
    assert index.stat().st_size==expected_size and digest(index)==expected_hash,'signed-index-mismatch'
    found=[];block=[];block_bytes=0
    with index.open() as f:
        for line in f:
            assert time.monotonic()<deadline,'index-deadline'
            if line.strip():
                block.append(line);block_bytes+=len(line);assert block_bytes<=131072
            else:
                d=paragraph(''.join(block));block=[];block_bytes=0
                if d.get('Package')=='nbd-client' and d.get('Version')==manifest['version']:found.append(d)
        if block:
            d=paragraph(''.join(block))
            if d.get('Package')=='nbd-client' and d.get('Version')==manifest['version']:found.append(d)
    assert len(found)==1,'package-identity';pkg=found[0]
    assert pkg['Architecture']=='amd64' and pkg['Filename']==manifest['filename'] and int(pkg['Size'])==manifest['size'] and pkg['SHA256']==manifest['sha256']
    out['authenticatedPackage']={'version':pkg['Version'],'sha256':pkg['SHA256'],'size':int(pkg['Size']),'releaseSha256':manifest['release']['sha256'],'indexSha256':expected_hash}
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):raise RuntimeError('redirect-refused')
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    url='https://archive.ubuntu.com/ubuntu/'+manifest['filename']
    with opener.open(url,timeout=10) as response:
        assert response.status==200 and response.geturl()==url
        data=response.read(manifest['size']+1)
    assert len(data)==manifest['size'] and hashlib.sha256(data).hexdigest()==manifest['sha256'],'archive-mismatch'
    archive=dest/'nbd-client.deb'
    with archive.open('xb') as f:f.write(data);f.flush();os.fsync(f.fileno())
    # dpkg-deb decodes the verified archive only; no install/configure or maintainer scripts.
    tarbytes=command('archiveData',['/usr/bin/dpkg-deb','--fsys-tarfile',str(archive)],5,2<<20,True)
    payload=None;member_name=None
    with tarfile.open(fileobj=io.BytesIO(tarbytes),mode='r:') as tar:
        count=0;total=0
        for member in tar:
            count+=1;total+=member.size;assert count<=256 and total<=2<<20
            name=member.name.removeprefix('./')
            assert not name.startswith('/') and '..' not in P(name).parts,'unsafe-member'
            if name in ('usr/sbin/nbd-client','sbin/nbd-client'):
                assert payload is None and member.isfile() and 0<member.size<=1<<20,'binary-member'
                payload=tar.extractfile(member).read((1<<20)+1);member_name=name
    assert payload is not None and len(payload)<=1<<20
    binary=dest/'nbd-client'
    with binary.open('xb') as f:f.write(payload);f.flush();os.fsync(f.fileno())
    binary.chmod(0o700)
    assert payload[:6]==b'\x7fELF\x02\x01','ELF64-little-endian-required'
    assert struct.unpack_from('<H',payload,18)[0]==62,'amd64-required'
    phoff=struct.unpack_from('<Q',payload,32)[0];phsize,phnum=struct.unpack_from('<HH',payload,54)
    assert phsize==56 and 0<phnum<=128 and phoff+phsize*phnum<=len(payload)
    interps=[]
    for i in range(phnum):
        off=phoff+i*phsize
        if struct.unpack_from('<I',payload,off)[0]==3:
            start=struct.unpack_from('<Q',payload,off+8)[0];size=struct.unpack_from('<Q',payload,off+32)[0]
            assert start+size<=len(payload) and 0<size<=256
            interps.append(payload[start:start+size].rstrip(b'\0').decode('ascii'))
    assert interps==['/lib64/ld-linux-x86-64.so.2'],'unexpected-interpreter'
    loader=owned_library(interps[0]);out['loader']=loader
    listed=command('loaderList',[loader['path'],'--list',str(binary)])
    libraries=[]
    for line in listed.splitlines():
        s=line.strip()
        if s.startswith('linux-vdso.so.1 '):continue
        if '=>' in s:
            mapped=s.split('=>',1)[1].strip().split()[0];assert mapped.startswith('/'),'unresolved-library'
        else:
            mapped=s.split()[0];assert P(mapped).resolve()==P(loader['path']),'unknown-loader-line'
        libraries.append(owned_library(mapped))
    assert libraries
    out['libraries']=libraries
    helptext=command('clientHelp',[str(binary),'-h'],ok_rc=(0,1))
    assert 'nbd-client' in helptext and ('unix' in helptext.lower() or '-u' in helptext),'unix-help-missing'
    out['binary']={'path':str(binary),'archiveMember':member_name,'bytes':binary.stat().st_size,'sha256':digest(binary)}
    out['status']='PRIVATE_TOOL_READY_NOT_ATTACHED'
except Exception as e:
    out['errors'].append(type(e).__name__+':'+str(e)[:180])
if dest.is_dir() and dest.stat().st_uid==os.getuid():
    try:
        with (dest/'RECEIPT.json').open('x') as f:json.dump(out,f,indent=2);f.write('\n')
    except Exception as e:out['errors'].append('receipt:'+type(e).__name__);out['status']='INCOMPLETE_NOT_USABLE'
print(json.dumps(out,sort_keys=True))
sys.exit(0 if out['status']=='PRIVATE_TOOL_READY_NOT_ATTACHED' and not out['errors'] else 2)

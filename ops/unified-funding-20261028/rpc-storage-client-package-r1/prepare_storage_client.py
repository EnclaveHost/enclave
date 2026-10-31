#!/usr/bin/env python3
"""Package the pinned NBD client with a private, verified ELF library closure.

No downloads, system installation, block devices, mounts or NBD connections.
Run inside an independently bounded, network-isolated unit. Outputs are new only.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import time


def digest(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def build(config):
    started = time.monotonic()
    if Path('/proc/sys/kernel/random/boot_id').read_text().strip() != config['bootId']:
        raise ValueError('Build host boot changed')
    available = next(int(x.split()[1])*1024 for x in Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:'))
    if available < 2*1024**3:
        raise ValueError('Build host memory floor')
    output = Path(config['output'])
    if shutil.disk_usage(output.parent).free < 16*1024**3:
        raise ValueError('Build host disk floor')
    rows = [config['client']] + config['libraries']
    if len(rows) != 14 or sum(r['bytes'] for r in rows) > 16*1024**2:
        raise ValueError('Expected bounded client and thirteen libraries')
    before = {}
    for row in rows:
        p = Path(row['path']); st = p.stat()
        if not p.is_file() or st.st_size != row['bytes'] or digest(p) != row['sha256']:
            raise ValueError('Pinned source changed: '+str(p))
        before[str(p)] = (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
    output.mkdir(mode=0o700)
    root = output/'nbd'; root.mkdir(); lib = root/'lib'; lib.mkdir()
    files = {}; sonames = {}; needed = set()
    for i, row in enumerate(rows):
        source = Path(row['path']); target = root/'nbd-client' if i == 0 else lib/source.name
        with source.open('rb') as src, target.open('xb') as dst:
            shutil.copyfileobj(src,dst,1024**2)
        target.chmod(0o755)
        if digest(target) != row['sha256']:
            raise ValueError('Copied bytes changed')
        files[str(target.relative_to(root))] = {'sha256':row['sha256'],'bytes':row['bytes']}
        r = subprocess.run(['/usr/bin/readelf','-dW',str(target)],capture_output=True,text=True,timeout=5,check=True)
        if len(r.stdout)>65536: raise ValueError('ELF metadata output bound')
        needed.update(re.findall(r'\(NEEDED\).*?\[([^\]]+)\]',r.stdout))
        names = re.findall(r'\(SONAME\).*?\[([^\]]+)\]',r.stdout)
        if i and len(names) != 1: raise ValueError('One library SONAME required')
        for name in names:
            if '/' in name or name in sonames: raise ValueError('Ambiguous SONAME')
            sonames[name] = target.name
            if name != target.name: (lib/name).symlink_to(target.name)
    if not needed <= set(sonames): raise ValueError('Incomplete ELF closure: '+repr(needed-set(sonames)))
    loader = lib/'ld-linux-x86-64.so.2'
    r = subprocess.run([str(loader),'--inhibit-cache','--library-path',str(lib),'--list',str(root/'nbd-client')],
                       env={'PATH':'/usr/bin:/bin','LANG':'C'},capture_output=True,text=True,timeout=5,check=True)
    if len(r.stdout)>16384 or r.stderr: raise ValueError('Unexpected loader output')
    resolved = re.findall(r'=>\s+(\S+)\s+\(',r.stdout)
    if len(resolved)!=12 or any(not Path(p).resolve().is_relative_to(lib.resolve()) for p in resolved):
        raise ValueError('Library escaped private closure')
    (output/'loader-list.txt').write_text(r.stdout)
    archive = output/'storage-client.tar'
    with tarfile.open(archive,'x') as tar:
        for p in sorted(root.rglob('*')):
            if p.is_dir(): continue
            info = tar.gettarinfo(str(p),arcname='opt/enclave-rpc/nbd/'+str(p.relative_to(root)))
            info.uid=info.gid=0;info.uname=info.gname='root';info.mtime=0
            if info.isfile():
                with p.open('rb') as f:tar.addfile(info,f)
            else:tar.addfile(info)
    for row in rows:
        p=Path(row['path']);st=p.stat()
        if before[str(p)]!=(st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns) or digest(p)!=row['sha256']:
            raise ValueError('Source changed during packaging')
    result={'archive':str(archive),'bytes':archive.stat().st_size,'sha256':digest(archive),'files':files,
            'sonames':sonames,'loaderList':r.stdout,'sourcesUnchanged':True,'seconds':time.monotonic()-started,
            'connectionsMade':False,'installed':False,'invocation':os.environ.get('INVOCATION_ID')}
    (output/'RESULT.json').write_text(json.dumps(result,indent=2)+'\n')
    return result

if __name__=='__main__':
    import sys
    print(json.dumps(build(json.loads(sys.argv[1]))))

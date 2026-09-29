#!/usr/bin/env python3
"""Overlay only scheduler files on a digest-checked control image, preserving all other cpio entries.
Usage: overlay-control-image.py BASE OUT COMMIT. COMMIT must be committed in this repository.
The output manifest records the base digest and every replacement; the old measurement is discarded.
"""
import gzip,hashlib,json,shutil,subprocess,sys
from pathlib import Path
base,out,commit=Path(sys.argv[1]),Path(sys.argv[2]),sys.argv[3]
repo=Path(__file__).resolve().parent.parent
if out.exists():raise SystemExit('output exists')
sha=lambda b:hashlib.sha256(b).hexdigest()
m=json.loads((base/'manifest.json').read_text())
compressed=(base/'initramfs.cpio.gz').read_bytes()
if sha(compressed)!=m['initramfs']['sha256']:raise SystemExit('base initramfs hash mismatch')
if sha((base/'vmlinuz').read_bytes())!=m['kernel']['sha256']:raise SystemExit('base kernel hash mismatch')
commit=subprocess.check_output(['git','rev-parse',commit+'^{commit}'],cwd=repo,text=True).strip()
paths={'app/supervisor.js':'supervisor.js','opt/metal/gsup.mjs':'metal/guest/gsup.mjs',
 'app/isolation/m4/guestd/supervisor-splice.mjs':'isolation/m4/guestd/supervisor-splice.mjs',
 'app/isolation/m4/guestd/supervisor-guestcert.mjs':'isolation/m4/guestd/supervisor-guestcert.mjs'}
replacements={k:subprocess.check_output(['git','show',commit+':'+v],cwd=repo) for k,v in paths.items()}
m.pop('expectedMeasurement',None);m.pop('initramfs',None)
m['controlOverlay']={'baseInitramfsSha256':sha(compressed),'commit':commit,'builder':'metal/overlay-control-image.py','files':[{'path':'/'+k,'sha256':sha(v)} for k,v in replacements.items()]}
replacements['opt/metal/manifest.json']=(json.dumps(m,indent=2)+'\n').encode()
raw=gzip.decompress(compressed); del compressed
out.mkdir(parents=True)
seen=set();off=0
# Keep the original ownership, modes, inode/hardlink metadata and entry order.
with (out/'initramfs.cpio.gz').open('wb') as target:
 with gzip.GzipFile(filename='',mode='wb',fileobj=target,mtime=0,compresslevel=9) as z:
  while off<len(raw):
   start=off;header=raw[off:off+110];off+=110
   if header[:6]!=b'070701':raise SystemExit('only newc input is supported')
   fields=[int(header[6+i*8:14+i*8],16) for i in range(13)]
   size,namesize=fields[6],fields[11]
   name=raw[off:off+namesize-1].decode();off=(off+namesize+3)&~3
   data=raw[off:off+size];off=(off+size+3)&~3
   key=name.removeprefix('./')
   if key in replacements:
    if key in seen or fields[4]!=1:raise SystemExit('duplicate or hardlinked replacement')
    seen.add(key);data=replacements[key];fields[6]=len(data)
    h=b'070701'+b''.join(f'{n:08x}'.encode() for n in fields)
    entry=h+name.encode()+b'\0';entry+=b'\0'*(-len(entry)%4);entry+=data;entry+=b'\0'*(-len(data)%4)
    z.write(entry)
   else:z.write(raw[start:off])
   if name=='TRAILER!!!':break
if seen!=set(replacements):raise SystemExit('base image missing required entries')
shutil.copy2(base/'vmlinuz',out/'vmlinuz');shutil.copy2(base/'cmdline',out/'cmdline')
f=out/'initramfs.cpio.gz';m['initramfs']={'sha256':hashlib.file_digest(f.open('rb'),'sha256').hexdigest(),'bytes':f.stat().st_size}
(out/'manifest.json').write_text(json.dumps(m,indent=2)+'\n')
print(m['initramfs'])

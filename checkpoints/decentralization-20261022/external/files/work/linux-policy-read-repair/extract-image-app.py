#!/usr/bin/env python3
"""extract-image-app.py IMAGE_INITRAMFS DEST: the app/ subtree (regular files, dirs, in-tree symlinks) of the corrected
release's image, read only, with that release's own cpio reader (linux-corrected-release/tree/metal/overlay-control-image.py).
DEST must not exist."""
import gzip,os,posixpath,stat,sys,importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('o','/home/steven/Documents/Codex/2026-10-18/wo/work/linux-corrected-release/tree/metal/overlay-control-image.py')
o=importlib.util.module_from_spec(spec);spec.loader.exec_module(o)
src,dest=Path(sys.argv[1]),Path(sys.argv[2]);dest.mkdir(parents=True);n=0
with gzip.open(src,'rb') as f:
    for key,name,fields,header in o.entries(f):
        data=o.exact(f,fields[6]);o.exact(f,-fields[6]%4)
        if not key.startswith('app/'):continue
        t=dest/key;m=fields[1]
        if stat.S_ISDIR(m):t.mkdir(parents=True,exist_ok=True)
        elif stat.S_ISREG(m):t.parent.mkdir(parents=True,exist_ok=True);t.write_bytes(data);n+=1
        elif stat.S_ISLNK(m):
            link=data.decode();r=posixpath.normpath(posixpath.join(posixpath.dirname(key),link))
            if not link.startswith('/') and r.startswith('app/'):
                t.parent.mkdir(parents=True,exist_ok=True)
                if not t.exists():os.symlink(link,t)
print(f'extracted {n} app files')

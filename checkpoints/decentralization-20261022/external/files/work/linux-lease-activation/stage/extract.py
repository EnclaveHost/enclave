#!/usr/bin/env python3
"""extract.py INITRAMFS DEST: the app/ and opt/metal/ subtrees of a newc initramfs (regular files, directories, and
symlinks that stay inside the subtree), for the image import check. Reads only; DEST must not exist."""
import gzip, os, posixpath, stat, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tree' / 'metal'))
import importlib.util
spec = importlib.util.spec_from_file_location('o', str(Path(__file__).resolve().parents[1] / 'tree/metal/overlay-control-image.py'))
o = importlib.util.module_from_spec(spec); spec.loader.exec_module(o)
src, dest = Path(sys.argv[1]), Path(sys.argv[2])
dest.mkdir(parents=True)
n = 0
with gzip.open(src, 'rb') as f:
    for key, name, fields, header in o.entries(f):
        data = o.exact(f, fields[6]); o.exact(f, -fields[6] % 4)
        if not (key.startswith('app/') or key.startswith('opt/metal/')) or key == 'TRAILER!!!':
            continue
        target = dest / key
        mode = fields[1]
        if stat.S_ISDIR(mode):
            target.mkdir(parents=True, exist_ok=True)
        elif stat.S_ISREG(mode):
            target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data); n += 1
        elif stat.S_ISLNK(mode):
            link = data.decode()
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(key), link))
            if not link.startswith('/') and (resolved.startswith('app/') or resolved.startswith('opt/metal/')):
                target.parent.mkdir(parents=True, exist_ok=True)
                if not target.exists(): os.symlink(link, target)
print(f'extracted {n} files')

#!/usr/bin/env python3
# usage: extract.py <cpio.gz> <outdir>: newc cpio, regular files + dirs only, never follows paths outside outdir
import gzip, hashlib, json, os, sys, stat
src, out = sys.argv[1], sys.argv[2]
data = gzip.open(src).read()
o, rows = 0, []
while True:
    h = data[o:o+110]; assert h[:6] in (b"070701", b"070702"), h[:6]
    f = [int(h[6+8*i:14+8*i], 16) for i in range(13)]
    mode, fsize, nsize = f[1], f[6], f[11]
    name = data[o+110:o+110+nsize-1].decode(); o = (o + 110 + nsize + 3) & ~3
    body = data[o:o+fsize]; o = (o + fsize + 3) & ~3
    if name == "TRAILER!!!": break
    p = os.path.normpath(os.path.join(out, name)); assert p.startswith(os.path.abspath(out)) or p.startswith(out)
    if stat.S_ISDIR(mode): os.makedirs(p, exist_ok=True)
    elif stat.S_ISREG(mode):
        os.makedirs(os.path.dirname(p), exist_ok=True); open(p, "wb").write(body)
    rows.append({"path": name, "mode": oct(mode), "bytes": fsize, "sha256": hashlib.sha256(body).hexdigest(),
                 **({"link": body.decode()} if stat.S_ISLNK(mode) else {})})
json.dump(rows, open(os.path.join(os.path.dirname(out.rstrip("/")), "f86fb512-files.json"), "w"), indent=1)
print(len(rows), "entries")

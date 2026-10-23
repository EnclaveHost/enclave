#!/usr/bin/env python3
# repack.py <baseline.cpio.gz> <out.cpio.gz|out.cpio|-> [path=replacement-file ...]  (.cpio = uncompressed, for gzip -n -9)
# The f86fb512 initrd convention: newc with UPPERCASE hex fields, entries in the baseline's own order, ino = index from 0, uid/gid/mtime/dev 0,
# nlink as the baseline, gzip -n -9 (mtime 0, OS 3). With no replacements the output must equal the baseline.
import gzip, hashlib, sys, zlib
src, out, reps = sys.argv[1], sys.argv[2], dict(a.split("=", 1) for a in sys.argv[3:])
data = gzip.decompress(open(src, "rb").read())
o, entries, tail = 0, [], b""
while True:
    f = [int(data[o+6+8*i:o+14+8*i], 16) for i in range(13)]
    ns = f[11]; name = data[o+110:o+110+ns-1].decode(); o2 = (o + 110 + ns + 3) & ~3
    body = data[o2:o2+f[6]]; nxt = (o2 + f[6] + 3) & ~3
    entries.append((f, name, body)); o = nxt
    if name == "TRAILER!!!": tail = data[o:]; break
seen = set()
raw = bytearray()
for i, (f, name, body) in enumerate(entries):
    if name in reps:
        body = open(reps[name], "rb").read(); seen.add(name)
    g = list(f); g[0] = i if name != "TRAILER!!!" else 0; g[6] = len(body)
    nb = name.encode() + b"\0"; g[11] = len(nb)
    h = b"070701" + "".join(f"{v:08X}" for v in g).encode() + nb
    raw += h + b"\0" * ((-len(h)) % 4) + body + b"\0" * ((-len(body)) % 4)
raw += tail
assert seen == set(reps), (seen, reps)
c = zlib.compressobj(9, zlib.DEFLATED, -15, 9)
gz = b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x02\x03" + c.compress(bytes(raw)) + c.flush() + zlib.crc32(raw).to_bytes(4, "little") + (len(raw) & 0xffffffff).to_bytes(4, "little")
print("uncompressed identical to baseline:", bytes(raw) == data, "trailing pad bytes:", len(tail))
print("output sha256:", hashlib.sha256(gz).hexdigest(), len(gz))
if out.endswith(".cpio"): open(out, "wb").write(bytes(raw))
elif out != "-": open(out, "wb").write(gz)

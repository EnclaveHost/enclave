"""entries.py A.cpio.gz B.cpio.gz : stream BOTH newc archives (64 KiB chunks) and print every entry that differs
(name, mode, size, sha256) as JSON lines, then a summary. Read-only."""
import gzip, hashlib, json, sys
def entries(path):
    out = {}
    with gzip.open(path, 'rb') as f:
        buf = bytearray()
        def read(n):
            while len(buf) < n:
                c = f.read(65536)
                if not c: raise EOFError(path)
                buf.extend(c)
            d = bytes(buf[:n]); del buf[:n]; return d
        while True:
            h = read(110); fld = [int(h[6+8*i:14+8*i], 16) for i in range(13)]
            mode, size, ns = fld[1], fld[6], fld[11]
            name = read(ns)[:-1].decode('utf-8', 'surrogateescape'); read((-(110+ns)) % 4)
            if name == 'TRAILER!!!': break
            hs = hashlib.sha256(); left = size
            while left: k = min(65536, left); hs.update(read(k)); left -= k
            read((-size) % 4)
            out[name] = (oct(mode), size, hs.hexdigest())
    return out
a, b = entries(sys.argv[1]), entries(sys.argv[2])
diff = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
for k in diff: print(json.dumps({'entry': k, 'a': a.get(k), 'b': b.get(k)}))
print(json.dumps({'entriesA': len(a), 'entriesB': len(b), 'differing': diff}))

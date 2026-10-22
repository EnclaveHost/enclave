#!/usr/bin/env python3
"""Minimal dag-pb link lister for the exported blocks: dagpb.py <cid> -> name, child cid, tsize. Reads content/export/ipfs."""
import base64, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); B = os.path.join(HERE, '../content/export/ipfs')
def varint(b, i):
    n = s = 0
    while True:
        x = b[i]; i += 1; n |= (x & 0x7f) << s; s += 7
        if x < 0x80: return n, i
def fields(b):
    i = 0
    while i < len(b):
        k, i = varint(b, i); f, t = k >> 3, k & 7
        if t == 2: l, i = varint(b, i); yield f, b[i:i + l]; i += l
        elif t == 0: v, i = varint(b, i); yield f, v
        else: raise ValueError(t)
def cidstr(raw): return 'b' + base64.b32encode(raw).decode().lower().rstrip('=')
def links(cid):
    out = []
    for f, v in fields(open(os.path.join(B, cid), 'rb').read()):
        if f == 2:
            d = dict(fields(v)); out.append((d.get(2, b'').decode(), cidstr(d[1]), d.get(3)))
    return out
if __name__ == '__main__':
    for l in links(sys.argv[1]): print(*l)

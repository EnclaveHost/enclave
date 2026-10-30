#!/usr/bin/env python3
"""Read-only: within the window spanning all differing .rodata bytes (pin vs candidate), compare the MULTISET of NUL-terminated
strings (reordering vs content change), and check that every differing .rela.dyn entry's addend points into that window."""
import mmap, struct, sys, collections
def load(p):
    f = open(p, "rb"); m = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    shoff, = struct.unpack_from("<Q", m, 0x28); es, n, si = struct.unpack_from("<HHH", m, 0x3A)
    H = [struct.unpack_from("<IIQQQQIIQQ", m, shoff + i * es) for i in range(n)]
    so = H[si][4]; nm = lambda o: m[so + o: m.find(b"\0", so + o)].decode()
    return m, {nm(h[0]): h for h in H}
pm, ps = load(sys.argv[1]); cm, cs = load(sys.argv[2])
h = ps[".rodata"]; off, size, va = h[4], h[5], h[3]
a = memoryview(pm)[off:off+size]; b = memoryview(cm)[off:off+size]
first = last = None; C = 1 << 16
for i in range(0, size, C):
    j = min(size, i + C)
    if a[i:j] != b[i:j]:
        for k in range(i, j):
            if a[k] != b[k]:
                first = k if first is None else first; last = k
print(f".rodata differing window: +0x{first:x} .. +0x{last:x} ({last-first+1} bytes)")
# widen to string boundaries
s = first
while s > 0 and a[s-1] != 0 and b[s-1] != 0: s -= 1
e = last
while e < size - 1 and (a[e] != 0 or b[e] != 0): e += 1
wa, wb = bytes(a[s:e+1]), bytes(b[s:e+1])
ca = collections.Counter(x for x in wa.split(b"\0") if x); cb = collections.Counter(x for x in wb.split(b"\0") if x)
only_a = ca - cb; only_b = cb - ca
print(f"window [+0x{s:x}, +0x{e:x}] {e-s+1} bytes; strings pin {sum(ca.values())} cand {sum(cb.values())}")
print(f"strings only in pin ({sum(only_a.values())}): {[x[:60].decode(errors='replace') for x in only_a]}")
print(f"strings only in cand ({sum(only_b.values())}): {[x[:60].decode(errors='replace') for x in only_b]}")
# relocations: Elf64_Rela (r_offset, r_info, r_addend), 24 bytes
r = ps[".rela.dyn"]; ro, rs = r[4], r[5]; lo, hi = va + s, va + e + 1
bad = tot = 0; types = collections.Counter()
for i in range(0, rs, 24):
    x = struct.unpack_from("<QQq", pm, ro + i); y = struct.unpack_from("<QQq", cm, ro + i)
    if x != y:
        tot += 1; types[(x[1] & 0xffffffff, y[1] & 0xffffffff)] += 1
        same_slot = x[0] == y[0] and x[1] == y[1]
        if not (same_slot and lo <= x[2] < hi and lo <= y[2] < hi): bad += 1
print(f".rela.dyn differing entries {tot}; types {dict(types)}; NOT (same slot+type, both addends inside the string window): {bad}")

#!/usr/bin/env python3
"""Read-only: is every differing .text byte (pin vs candidate) inside a 4-byte RIP-relative displacement whose target, in BOTH
binaries, lies in the .rodata window [lo, hi) of reordered strings? (displacement at p, target = va(p) + 4 + disp; covers
lea/mov reg,[rip+d] without trailing immediates). Counts bytes not so explained."""
import mmap, struct, sys
def load(p):
    f = open(p, "rb"); m = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    shoff, = struct.unpack_from("<Q", m, 0x28); es, n, si = struct.unpack_from("<HHH", m, 0x3A)
    H = [struct.unpack_from("<IIQQQQIIQQ", m, shoff + i * es) for i in range(n)]
    so = H[si][4]; nm = lambda o: m[so + o: m.find(b"\0", so + o)].decode()
    return m, {nm(h[0]): h for h in H}
pm, ps = load(sys.argv[1]); cm, cs = load(sys.argv[2])
ro = ps[".rodata"]; lo, hi = ro[3] + int(sys.argv[3], 16), ro[3] + int(sys.argv[4], 16) + 1
t = ps[".text"]; off, size, va = t[4], t[5], t[3]
a = memoryview(pm)[off:off+size]; b = memoryview(cm)[off:off+size]
diffs = []; C = 1 << 16
for i in range(0, size, C):
    j = min(size, i + C)
    if a[i:j] != b[i:j]: diffs += [k for k in range(i, j) if a[k] != b[k]]
covered = set(); unexplained = []
for k in diffs:
    if k in covered: continue
    ok = False
    for p in range(k - 3, k + 1):
        if p < 0 or p + 4 > size: continue
        da, = struct.unpack_from("<i", a, p); db, = struct.unpack_from("<i", b, p)
        ta, tb = va + p + 4 + da, va + p + 4 + db
        if lo <= ta < hi and lo <= tb < hi and all(a[q] == b[q] for q in range(max(0, p - 3), p)):
            covered.update(range(p, p + 4)); ok = True; break
    if not ok: unexplained.append(k)
print(f".text differing bytes {len(diffs)}; explained as RIP-relative displacements into the reordered string window: {len(diffs) - len(unexplained)}; unexplained: {len(unexplained)}")
for k in unexplained[:10]: print(f"   unexplained at .text+0x{k:x}: pin {bytes(a[max(0,k-6):k+6]).hex()} cand {bytes(b[max(0,k-6):k+6]).hex()}")

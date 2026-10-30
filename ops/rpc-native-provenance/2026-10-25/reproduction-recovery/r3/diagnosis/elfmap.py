#!/usr/bin/env python3
"""Read-only: map the bytes that differ between two same-layout ELFs (.text/.rodata/.rela.dyn) to the containing symbol of the
(identical) symbol table; print a small per-crate/function summary and short printable snippets of differing .rodata runs."""
import mmap, struct, sys, subprocess, collections, re
def load(p):
    f = open(p, "rb"); m = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    shoff, = struct.unpack_from("<Q", m, 0x28); es, n, si = struct.unpack_from("<HHH", m, 0x3A)
    H = [struct.unpack_from("<IIQQQQIIQQ", m, shoff + i * es) for i in range(n)]
    so = H[si][4]; nm = lambda o: m[so + o: m.find(b"\0", so + o)].decode()
    return m, {nm(h[0]): h for h in H}
pm, ps = load(sys.argv[1]); cm, cs = load(sys.argv[2])
sym = ps[".symtab"]; st = ps[".strtab"]; syms = []
for i in range(sym[5] // 24):
    nmo, info, oth, shn, val, sz = struct.unpack_from("<IBBHQQ", pm, sym[4] + i * 24)
    if sz and (info & 0xf) in (1, 2):
        syms.append((val, sz, pm[st[4] + nmo: pm.find(b"\0", st[4] + nmo)].decode(errors="replace")))
syms.sort(); addrs = [s[0] for s in syms]
import bisect
def owner(va):
    i = bisect.bisect_right(addrs, va) - 1
    return syms[i][2] if i >= 0 and va < syms[i][0] + syms[i][1] else "(no symbol)"
def runs(sec):
    h = ps[sec]; off, size, va = h[4], h[5], h[3]; a = memoryview(pm)[off:off+size]; b = memoryview(cm)[off:off+size]
    out = []; i = 0; CH = 1 << 16
    while i < size:
        j = min(size, i + CH)
        if a[i:j] != b[i:j]:
            k = i
            while k < j:
                if a[k] != b[k]:
                    s = k
                    while k < j and (a[k] != b[k] or (k + 1 < j and a[k+1] != b[k+1])): k += 1
                    out.append((va + s, k - s, s))
                k += 1
        i = j
    return out, a, b
def crate(name):
    d = subprocess.run(["c++filt"], input=name, capture_output=True, text=True).stdout.strip() if name.startswith("_ZN") else name
    c = re.split(r"::|<|\s", d.lstrip("<_"))[0]
    return c, d
for sec in (".text", ".rodata", ".rela.dyn"):
    r, a, b = runs(sec)
    per = collections.Counter(); percr = collections.Counter(); ex = {}
    for va, ln, _ in r:
        o = owner(va); per[o] += ln
        c, d = crate(o) if o != "(no symbol)" else ("(no symbol)", o); percr[c] += ln; ex.setdefault(c, d)
    print(f"\n== {sec}: {len(r)} differing runs, {sum(x[1] for x in r)} bytes; by crate (bytes):")
    for c, v in percr.most_common(12): print(f"   {v:>7}  {c}   e.g. {ex[c][:110]}")
    if sec == ".text":
        print(f"   functions touched: {len(per)}; top:")
        for o, v in per.most_common(8): print(f"   {v:>7}  {crate(o)[1][:120]}")
    if sec == ".rodata":
        print("   first differing runs (printable context, 40 bytes each side):")
        for va, ln, s in r[:6]:
            ctx = lambda x: re.sub(rb"[^ -~]", b".", bytes(x[max(0, s-8): s+40])).decode()
            print(f"   +0x{s:x} len {ln}: pin '{ctx(a)}' | cand '{ctx(b)}'")

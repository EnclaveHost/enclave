#!/usr/bin/env python3
"""Read-only ELF comparison: per-section sha256, size and differing-byte counts of each candidate vs the pin, plus the
GNU build-id. Prints a small summary only (no disassembly, no section contents).  elfdiff.py PIN CAND...  """
import hashlib, mmap, struct, sys
def sections(path):
    f = open(path, "rb"); m = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    assert m[:4] == b"\x7fELF" and m[4] == 2 and m[5] == 1, "ELF64 LE expected"
    shoff, = struct.unpack_from("<Q", m, 0x28); shentsize, shnum, shstrndx = struct.unpack_from("<HHH", m, 0x3A)
    hdr = [struct.unpack_from("<IIQQQQIIQQ", m, shoff + i * shentsize) for i in range(shnum)]
    stroff = hdr[shstrndx][4]
    name = lambda o: m[stroff + o: m.find(b"\0", stroff + o)].decode()
    out = {}
    for h in hdr:
        n = name(h[0]); typ, off, size = h[1], h[4], h[5]
        data = memoryview(b"") if typ == 8 else memoryview(m)[off: off + size]          # SHT_NOBITS has no file bytes
        out[n] = {"off": off, "size": size, "data": data}
    return m, out
def buildid(secs):
    d = secs.get(".note.gnu.build-id", {}).get("data", memoryview(b""))
    return bytes(d[16:]).hex() if len(d) > 16 else None
pin_m, pin = sections(sys.argv[1])
print(f"PIN {sys.argv[1].split('/')[-4]}…/helios size {len(pin_m)} build-id {buildid(pin)} sections {len(pin)}")
for cand in sys.argv[2:]:
    m, c = sections(cand)
    print(f"\nCAND {cand.split('/')[-4]} size {len(m)} (pin {len(pin_m)}, delta {len(m)-len(pin_m)}) build-id {buildid(c)}")
    same = []; rows = []
    for n in list(pin) + [k for k in c if k not in pin]:
        a, b = pin.get(n), c.get(n)
        if a is None or b is None: rows.append(f"  {n:28s} only in {'cand' if a is None else 'pin'}"); continue
        if a["data"] == b["data"] and a["size"] == b["size"]: same.append(n); continue
        if a["size"] == b["size"]:
            diff = sum(1 for x, y in zip(a["data"], b["data"]) if x != y) if a["size"] < 64 << 20 else -1
        else: diff = None
        rows.append(f"  {n:28s} size pin {a['size']:>10} cand {b['size']:>10}  " + (f"bytes differing {diff}" if diff is not None else "SIZE DIFFERS") +
                    f"  sha pin {hashlib.sha256(a['data']).hexdigest()[:12]} cand {hashlib.sha256(b['data']).hexdigest()[:12]}")
    print(f"  identical sections ({len(same)}): {', '.join(same)}"); print("  differing sections:"); print("\n".join(rows) if rows else "  none")

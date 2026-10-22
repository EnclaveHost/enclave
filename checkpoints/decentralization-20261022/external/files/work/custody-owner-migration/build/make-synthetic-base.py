#!/usr/bin/env python3
# A SMALL synthetic metal "dist" for builder-equivalence tests only: newc cpio (dirs, odd-sized files, opt/metal/gsup.mjs
# mid-archive, TRAILER!!! then zero padding to 512), gzip, a fake vmlinuz, cmdline and a manifest with their hashes.
import gzip, hashlib, json, os, sys
out = sys.argv[1]; os.makedirs(out)
rnd = lambda n, seed: hashlib.shake_256(seed.encode()).digest(n)
ino = [0]
def ent(name, mode, data=b""):
    ino[0] += 1
    nm = name.encode() + b"\0"
    f = [ino[0], mode, 0, 0, 2 if mode >> 12 == 4 else 1, 1700000000, len(data), 0, 0, 0, 0, len(nm), 0]
    h = b"070701" + b"".join(b"%08x" % x for x in f) + nm
    return h + b"\0" * ((4 - len(h) % 4) % 4) + data + b"\0" * ((4 - len(data) % 4) % 4)
parts = [ent(".", 0o040755), ent("opt", 0o040755), ent("opt/metal", 0o040755), ent("usr", 0o040755)]
for i, n in enumerate([1, 3, 4097, 70001, 0, 12345]): parts.append(ent(f"usr/f{i}.bin", 0o100644, rnd(n, f"f{i}")))
parts.append(ent("opt/metal/gsup.mjs", 0o100644, b"// base gsup\n"))
parts.append(ent("opt/metal/agent.mjs", 0o100644, rnd(999, "agent")))
parts.append(ent("TRAILER!!!", 0))
raw = b"".join(parts); raw += b"\0" * ((512 - len(raw) % 512) % 512)
gz = gzip.compress(raw, 9, mtime=0)
open(f"{out}/initramfs.cpio.gz", "wb").write(gz)
k = rnd(4096, "kernel"); open(f"{out}/vmlinuz", "wb").write(k)
open(f"{out}/cmdline", "w").write("console=ttyS0 metal.mode=${MODE}\n")
json.dump({"kernel": {"sha256": hashlib.sha256(k).hexdigest()}, "initramfs": {"sha256": hashlib.sha256(gz).hexdigest()}}, open(f"{out}/manifest.json", "w"))
print(out, hashlib.sha256(gz).hexdigest())

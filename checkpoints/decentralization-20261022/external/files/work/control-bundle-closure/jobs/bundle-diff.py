#!/usr/bin/env python3
"""Old vs new platform-api bundle: split each at esbuild's per-module '// <path>' headers and report which modules' bytes
differ. Fails unless the ONLY differing module is metal/guest/lease-gas-conduit.bundle.mjs, and unless the manifests differ
only in that input's hash and the bundle's own sha256/bytes."""
import json, re, sys
old, new, om, nm = sys.argv[1:5]
hdr = re.compile(r"^// ([A-Za-z0-9_@./+-]+\.(?:mjs|js|cjs|json))$", re.M)
def sections(path):
    t = open(path, encoding="utf-8").read()
    idx = [(m.start(), m.group(1)) for m in hdr.finditer(t)]
    out = {"<banner>": t[: idx[0][0]] if idx else t}
    for i, (s, name) in enumerate(idx):
        e = idx[i + 1][0] if i + 1 < len(idx) else len(t)
        out[name] = out.get(name, "") + t[s:e]
    return out
a, b = sections(old), sections(new)
changed = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
print(f"modules: old {len(a)}, new {len(b)}; differing: {changed}")
ma, mb = json.load(open(om)), json.load(open(nm))
inp = sorted(k for k in set(ma["inputs"]) | set(mb["inputs"]) if ma["inputs"].get(k) != mb["inputs"].get(k))
other = sorted(k for k in set(ma) | set(mb) if k != "inputs" and ma.get(k) != mb.get(k))
print(f"manifest inputs differing: {inp}; other manifest fields differing: {other}")
for k in changed:
    print(f"  {k}: {len(a.get(k, ''))} -> {len(b.get(k, ''))} bytes")
ok = changed == ["metal/guest/lease-gas-conduit.bundle.mjs"] and inp == ["metal/guest/lease-gas-conduit.bundle.mjs"] and set(other) <= {"sha256", "bytes"}
print("ONLY the conduit module and its manifest entry changed" if ok else "UNEXPECTED difference")
sys.exit(0 if ok else 1)

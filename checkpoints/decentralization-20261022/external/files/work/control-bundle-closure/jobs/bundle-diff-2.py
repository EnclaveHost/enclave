#!/usr/bin/env python3
"""Second, corrected bundle comparison (bundle-diff.py demanded byte-equality outside the conduit, which esbuild's
bundle-wide collision renaming does not give). Old vs new platform-api bundle, split at esbuild's per-module '// <path>'
headers. Passes only if:
  1. the manifests differ ONLY in the conduit input hash and the bundle's own sha256/bytes (every input is byte-identical);
  2. the conduit section differs;
  3. EVERY other differing section is identical once identifier tokens are normalized (trailing digits stripped), i.e. the
     only change outside the conduit is esbuild renaming (A2 -> A3, S3 -> S2), never code.
It also lists the conduit's top-level declarations old vs new: the names whose change shifts esbuild's rename suffixes."""
import json, re, sys
old, new, om, nm = sys.argv[1:5]
hdr = re.compile(r"^// ([A-Za-z0-9_@./+-]+\.(?:mjs|js|cjs|json))$", re.M)
def sections(p):
    t = open(p, encoding="utf-8").read(); idx = [(m.start(), m.group(1)) for m in hdr.finditer(t)]
    out = {"<banner>": t[: idx[0][0]]}
    for i, (s, n) in enumerate(idx): out[n] = out.get(n, "") + t[s:(idx[i + 1][0] if i + 1 < len(idx) else len(t))]
    return out
ident = re.compile(r"\b([A-Za-z_$][A-Za-z_$]*?(?:[A-Za-z_$]|\d+[A-Za-z_$]+)*)\d+\b")
norm = lambda s: ident.sub(r"\1", s)
a, b = sections(old), sections(new)
CONDUIT = "metal/guest/lease-gas-conduit.bundle.mjs"
ma, mb = json.load(open(om)), json.load(open(nm))
inp = sorted(k for k in set(ma["inputs"]) | set(mb["inputs"]) if ma["inputs"].get(k) != mb["inputs"].get(k))
other = sorted(k for k in set(ma) | set(mb) if k != "inputs" and ma.get(k) != mb.get(k))
changed = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
renamed_only = [k for k in changed if k != CONDUIT and norm(a.get(k, "")) == norm(b.get(k, ""))]
real = [k for k in changed if k != CONDUIT and k not in renamed_only]
decl = re.compile(r"^(?:var|let|const|function|async function|class)\s+([A-Za-z_$][\w$]*)", re.M)
od, nd = set(decl.findall(a.get(CONDUIT, ""))), set(decl.findall(b.get(CONDUIT, "")))
print(f"manifest inputs differing: {inp}; other manifest fields differing: {other}")
print(f"modules: {len(a)} old, {len(b)} new; differing: {len(changed)} (conduit + {len(renamed_only)} rename-only + {len(real)} other)")
print(f"rename-only sections: {renamed_only}")
print(f"conduit top-level names only in OLD: {sorted(od - nd)}; only in NEW: {sorted(nd - od)}")
if real: print(f"NON-RENAME differences outside the conduit: {real}")
ok = inp == [CONDUIT] and set(other) <= {"sha256", "bytes"} and CONDUIT in changed and not real
print("PASS: only the conduit changed; every other byte difference is esbuild identifier renaming" if ok else "FAIL")
sys.exit(0 if ok else 1)

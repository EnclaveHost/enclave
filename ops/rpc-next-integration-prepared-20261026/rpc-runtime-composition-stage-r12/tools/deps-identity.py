#!/usr/bin/env python3
"""Lock identity of a node_modules closure against a tree's lockfile, read-only.
deps-identity.py <git-dir> <ref> <lockfile dir ('.'|relay|network|...)> <node_modules dir>  -> one JSON line, exit 1 on mismatch.
Rule (npm's own hidden lockfile node_modules/.package-lock.json): every package present has the lock's exact version AND
integrity; a lock package absent from node_modules must be `optional` (other platforms); nothing extra. Also a content
treehash of the closure (sha256 over sorted file paths + bytes + symlink targets), so a copy and a post-run state can be compared."""
import hashlib, json, os, subprocess, sys
git, ref, d, nm = sys.argv[1:5]
lock = json.loads(subprocess.run(["git", f"--git-dir={git}", "show", f"{ref}:{'' if d == '.' else d + '/'}package-lock.json"], capture_output=True, check=True).stdout)
lk = {k: v for k, v in lock["packages"].items() if k}
hid = json.load(open(os.path.join(nm, ".package-lock.json")))["packages"]
miss = [k for k in lk if k not in hid]; extra = [k for k in hid if k not in lk]
mism = [k for k in lk if k in hid and (lk[k].get("version"), lk[k].get("integrity")) != (hid[k].get("version"), hid[k].get("integrity"))]
nonopt = [k for k in miss if not lk[k].get("optional")]
def treehash(root):
    h = hashlib.sha256()
    for dp, dn, fn in os.walk(root):
        dn.sort()
        for n in sorted(fn + [x for x in dn if os.path.islink(os.path.join(dp, x))]):
            p = os.path.join(dp, n); r = os.path.relpath(p, root).encode()
            if os.path.islink(p):
                t = os.readlink(p); h.update(b"L" + r + b"\0" + t.encode() + b"\0")
                if os.path.isabs(t) or not os.path.realpath(p).startswith(os.path.realpath(root) + os.sep): print(json.dumps({"error": f"symlink leaves the closure: {r.decode()} -> {t}"})); sys.exit(1)
            else: h.update(b"F" + r + b"\0" + hashlib.sha256(open(p, "rb").read()).digest())
    return h.hexdigest()
ok = not (nonopt or extra or mism)
print(json.dumps({"ref": ref, "lockfile": d, "lockSha256": hashlib.sha256(json.dumps(lk, sort_keys=True).encode()).hexdigest()[:16], "packages": len(hid),
  "optionalAbsent": len(miss), "nonOptionalAbsent": nonopt[:5], "extra": extra[:5], "mismatch": mism[:5], "ok": ok, "treehash": treehash(nm) if ok else None}))
sys.exit(0 if ok else 1)

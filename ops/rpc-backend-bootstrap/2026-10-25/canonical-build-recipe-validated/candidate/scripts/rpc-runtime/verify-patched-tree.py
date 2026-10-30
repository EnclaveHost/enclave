#!/usr/bin/env python3
"""verify-patched-tree.py <git-repo> <commit> <tree-dir> <PATCHED.sha256>: fail closed unless <tree-dir> is EXACTLY <commit>'s
tree plus the reviewed patch: every file the manifest names has its sha256, every other file of <commit> is byte-identical
(git blob id) with the same type, and no file is missing or extra. Reads git objects only (ls-tree); writes nothing."""
import hashlib, os, subprocess, sys
def fail(m): print(f"verify-patched-tree: {m}", file=sys.stderr); sys.exit(6)
def main(repo, commit, root, manifest):
    patched = {}
    for l in open(manifest):
        d, p = l.rstrip("\n").split("  ", 1)
        if len(d) != 64 or p in patched or p.startswith("/") or ".." in p.split("/"): fail(f"bad manifest line {l!r}")
        patched[p] = d
    base = {}
    out = subprocess.run(["git", "-C", repo, "ls-tree", "-r", "-z", "--full-tree", commit], check=True, capture_output=True).stdout
    for e in out.split(b"\0"):
        if not e: continue
        meta, p = e.split(b"\t", 1); mode, typ, oid = meta.decode().split()
        if typ != "blob": fail(f"{p.decode()}: {typ} entries are not supported")
        base[p.decode()] = (mode, oid)
    have = {}
    for d, dirs, files in os.walk(root):
        for n in files + [x for x in dirs if os.path.islink(os.path.join(d, x))]:
            f = os.path.join(d, n); have[os.path.relpath(f, root)] = f
    want = set(base) | set(patched)
    if set(have) != want:
        fail(f"file set differs: missing {sorted(want - set(have))[:5]}, extra {sorted(set(have) - want)[:5]}")
    for p, d in patched.items():
        f = have[p]
        if os.path.islink(f) or hashlib.sha256(open(f, "rb").read()).hexdigest() != d: fail(f"{p}: not the reviewed patched content")
    for p, (mode, oid) in base.items():
        if p in patched: continue
        f = have[p]
        if mode == "120000":
            if not os.path.islink(f): fail(f"{p}: not a symlink")
            data = os.readlink(f).encode()
        else:
            if os.path.islink(f) or not os.path.isfile(f): fail(f"{p}: not a regular file")
            if (mode == "100755") != bool(os.stat(f).st_mode & 0o100): fail(f"{p}: mode differs")
            data = open(f, "rb").read()
        if hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest() != oid: fail(f"{p}: differs from {commit}")
    new = sorted(set(patched) - set(base))
    print(f"patched tree OK: {len(base)} files of {commit[:12]}, {len(set(patched) & set(base))} patched, {len(new)} added, nothing else")
if __name__ == "__main__":
    if len(sys.argv) != 5: fail(__doc__)
    main(*sys.argv[1:])

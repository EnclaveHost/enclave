#!/usr/bin/env python3
"""overlay.py <main> <tree> [<dest>]: the candidate's scoped delta against CURRENT main.

Changed = a tree file whose hash differs from its recorded base (BASE.sha256, BASE-ADDED.sha256); new = a tree file with
no base. A changed file whose CURRENT main hash is no longer its base is STALE (another worker changed it): reported and
fatal. With <dest>, copies every changed/new file over <dest> (a scratch copy of main). Prints the inventory."""
import hashlib, os, sys
here = os.path.dirname(os.path.abspath(__file__))
main, tree = sys.argv[1], sys.argv[2]
dest = sys.argv[3] if len(sys.argv) > 3 else None
def h(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()
base = {}
for fn in ("BASE.sha256", "BASE-ADDED.sha256", "BASE-REBASED.sha256", "BASE-REFRESHED.sha256"):
    p = os.path.join(here, fn)
    if os.path.exists(p):
        for line in open(p):
            d, rel = line.rstrip("\n").split("  ", 1)
            if d == "DELETED":
                base.pop(os.path.normpath(rel), None)
                continue
            base[os.path.normpath(rel)] = d
SKIP_DIRS = {"target", "__pycache__", "node_modules"}
changed, new, stale = [], [], []
for root, dirs, files in os.walk(tree):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
    for f in files:
        p = os.path.join(root, f)
        if os.path.islink(p):
            continue
        rel = os.path.normpath(os.path.relpath(p, tree))
        cur = h(p)
        if rel in base:
            if cur == base[rel]:
                continue
            m = os.path.join(main, rel)
            mh = h(m) if os.path.exists(m) else None
            (stale if mh != base[rel] else changed).append((rel, base[rel], cur, mh))
        else:
            m = os.path.join(main, rel)
            if os.path.exists(m):
                stale.append((rel, None, cur, h(m)))
            else:
                new.append((rel, None, cur, None))
for kind, l in (("CHANGED", changed), ("NEW", new), ("STALE", stale)):
    for rel, b, c, mh in sorted(l):
        print(f"{kind} {rel} base={b or '-'} result={c} main={mh or '-'}")
if stale:
    sys.exit("overlay: STALE files: main moved under them; rebase before integrating")
if dest:
    import shutil
    for rel, *_ in changed + new:
        os.makedirs(os.path.dirname(os.path.join(dest, rel)) or dest, exist_ok=True)
        shutil.copy2(os.path.join(tree, rel), os.path.join(dest, rel))
    print(f"overlay: {len(changed)} changed + {len(new)} new files copied over {dest}")

#!/usr/bin/env python3
"""Closure of work/shield-certificates (read-only on every other tree): compares tree/ with its base manifest
(base-tree.sha256 = the exact copy of work/app-zone-certificates/tree taken at base-time.txt) and writes
  closure-manifest.json  modified files (base sha, result sha, current work/app-zone-certificates/tree sha, current main
                         work/enclave sha) and new files (sha);
  patches/<path>.diff    one unified diff per modified file against the base bytes (taken from work/app-zone-certificates/tree,
                         and refused if those bytes no longer hash to the base);
  inventory.sha256       every closure artifact.
Excludes node_modules and Python caches. Exit 0 only when every base file is accounted for."""
import difflib, hashlib, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
TREE, APPZONE, MAIN = os.path.join(HERE, "tree"), os.path.join(HERE, "../app-zone-certificates/tree"), os.path.join(HERE, "../enclave")
def sha(p):
    try:
        with open(p, "rb") as f: return hashlib.sha256(f.read()).hexdigest()
    except FileNotFoundError: return None
base = {}
for line in open(os.path.join(HERE, "base-tree.sha256")):
    h, p = line.rstrip("\n").split("  ", 1); p = p[2:] if p.startswith("./") else p
    if "__pycache__/" not in p: base[p] = h
now = {}
for root, dirs, files in os.walk(TREE):
    dirs[:] = [d for d in dirs if d not in ("node_modules", "__pycache__")]
    for f in files:
        if os.path.islink(os.path.join(root, f)): continue   # in-repo symlinks: the base manifest lists regular files only
        rel = os.path.relpath(os.path.join(root, f), TREE); now[rel] = sha(os.path.join(root, f))
missing = sorted(set(base) - set(now))
if missing: sys.exit("base files missing from the tree: " + ", ".join(missing[:10]))
modified = sorted(p for p in base if now[p] != base[p]); new = sorted(set(now) - set(base))
os.makedirs(os.path.join(HERE, "patches"), exist_ok=True)
out = {"base": "work/app-zone-certificates/tree copy at " + open(os.path.join(HERE, "base-time.txt")).read().strip(),
       "modified": [], "new": [{"path": p, "sha256": now[p]} for p in new]}
for p in modified:
    src = os.path.join(APPZONE, p)
    if sha(src) != base[p]: sys.exit(f"{p}: work/app-zone-certificates/tree no longer holds the base bytes")
    a = open(src, "rb").read().decode("utf-8", "replace").splitlines(keepends=True)
    b = open(os.path.join(TREE, p), "rb").read().decode("utf-8", "replace").splitlines(keepends=True)
    diff = "".join(difflib.unified_diff(a, b, "a/" + p, "b/" + p, n=3))
    dp = os.path.join(HERE, "patches", p.replace("/", "__") + ".diff"); open(dp, "w").write(diff)
    out["modified"].append({"path": p, "base": base[p], "result": now[p], "appZoneTreeNow": sha(src), "mainNow": sha(os.path.join(MAIN, p)),
                            "patch": os.path.relpath(dp, HERE)})
open(os.path.join(HERE, "closure-manifest.json"), "w").write(json.dumps(out, indent=1) + "\n")
inv = []
for d in ("patches", "deploy", "logs"):
    for root, _, files in os.walk(os.path.join(HERE, d)):
        for f in sorted(files): q = os.path.join(root, f); inv.append(f"{sha(q)}  {os.path.relpath(q, HERE)}")
for f in ("closure-manifest.json", "base-tree.sha256", "base-time.txt", "make-closure.py"): inv.append(f"{sha(os.path.join(HERE, f))}  {f}")
for p in new + modified: inv.append(f"{now[p]}  tree/{p}")
open(os.path.join(HERE, "inventory.sha256"), "w").write("\n".join(sorted(set(inv), key=lambda l: l[66:])) + "\n")
print(f"modified {len(modified)}, new {len(new)}, inventory {len(inv)} entries")
for m in out["modified"]: print(f"  M {m['path']}  {m['base'][:12]} -> {m['result'][:12]}  (main {str(m['mainNow'])[:12]})")
for n in out["new"]: print(f"  A {n['path']}  {n['sha256'][:12]}")

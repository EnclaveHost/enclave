#!/usr/bin/env python3
"""READ-ONLY: route-unique lines LOST by the composition. For every path where the candidate differs from the route tip:
lines of the route tip that occur in NO lineage state of the path since adf9c5bbf (route-unique) and are absent from the candidate.
Usage: route-loss.py <git-dir> <candidate-ref> -> JSON {path: [lost lines]} for paths that lost any (blank/comment-only lines reported separately)."""
import json, subprocess, sys
G, C = sys.argv[1], sys.argv[2]
def run(*a): r = subprocess.run(["git", f"--git-dir={G}", *a], capture_output=True); return r.stdout if r.returncode == 0 else None
def lines(ref, p): b = run("show", f"{ref}:{p}"); return None if b is None else [l.strip() for l in b.decode("utf8", "replace").split("\n")]
diff = run("diff", "--name-only", "-z", C, "refs/src/route").decode().split("\0")
out = {}
for p in [x for x in diff if x]:
    t = lines("refs/src/route", p)
    if t is None: continue
    cand = set(lines(C, p) or [])
    L = set()
    for c in run("log", "--format=%H", "adf9c5bbf..refs/r2/stage1", "--", p).decode().split() + ["adf9c5bbf"]:
        L |= set(lines(c, p) or [])
    lost = [l for l in dict.fromkeys(t) if l and l not in L and l not in cand]
    code = [l for l in lost if not l.startswith(("//", "*", "/*", "#"))]
    if lost: out[p] = {"code": code, "commentOnly": len(lost) - len(code)}
json.dump(out, sys.stdout, indent=1)

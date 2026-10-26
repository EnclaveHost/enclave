#!/usr/bin/env python3
"""READ-ONLY source-loss review: for each source head, the lines UNIQUE to that head (in none of the other heads' versions and not in
the shared base 7752a4239) that are absent from the candidate. -> JSON {head: {path: [lines]}} (code lines; comments counted)."""
import json, subprocess, sys
G = ["git", f"--git-dir={sys.argv[1]}"]; C = sys.argv[2]
HEADS = {"consumers-credit": "refs/src/consumers-credit", "leaseRelay": "refs/src/leaseRelay", "verifier": "refs/src/verifier", "route": "refs/src/route"}
def ls(r): return {l.split("\t")[1]: l.split()[2] for l in subprocess.run(G + ["ls-tree", "-r", r], capture_output=True, text=True).stdout.splitlines()}
cache = {}
def lines(b):
    if b not in cache: cache[b] = set(x.strip() for x in subprocess.run(G + ["cat-file", "blob", b], capture_output=True).stdout.decode("utf8", "replace").split("\n"))
    return cache[b]
T = {k: ls(v) for k, v in HEADS.items()}; base = ls("7752a4239"); cand = ls(C); out = {}
for k, t in T.items():
    for p, b in t.items():
        if cand.get(p) == b or not p.endswith((".mjs", ".js", ".py", ".sh", ".json", ".md", ".cmd", ".ps1", ".sol")) or p.startswith(("ops/", "isolation/")): continue
        mine = lines(b); others = set()
        for k2, t2 in T.items():
            if k2 != k and p in t2: others |= lines(t2[p])
        if p in base: others |= lines(base[p])
        c = lines(cand[p]) if p in cand else set()
        lost = [l for l in mine - others - c if l and not l.startswith(("//", "*", "/*", "#", "rem "))]
        if lost: out.setdefault(k, {})[p] = sorted(lost)[:20] + ([f"... {len(lost) - 20} more"] if len(lost) > 20 else [])
json.dump(out, sys.stdout, indent=1)

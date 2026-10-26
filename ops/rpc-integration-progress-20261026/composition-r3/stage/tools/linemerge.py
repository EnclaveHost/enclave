#!/usr/bin/env python3
"""Line-provenance merge of ours (lineage result) and theirs (route tip) for one path. Every differing block of
difflib(ours -> theirs) is classified by EXACT line provenance:
  theirs lines: in some lineage state of the path -> STALE (route carries text the lineage moved past)  else ROUTE-UNIQUE
  ours lines:   in some route state of the path   -> ROUTE-REMOVED (route had it and dropped it)          else LINEAGE-ONLY
Decision per block: keep ours if theirs side is STALE/empty and ours side is LINEAGE-ONLY/empty; apply theirs if theirs
is ROUTE-UNIQUE/empty and ours is ROUTE-REMOVED/empty; otherwise MANUAL. Usage: linemerge.py PATH OURS_REF THEIRS_REF [decisions.json]"""
import difflib, json, subprocess, sys
G = ["git", "--git-dir=src.git"]
def run(*a): return subprocess.run(G + list(a), capture_output=True).stdout
def lines_at(ref, p): return run("show", f"{ref}:{p}").decode("utf8", "replace").split("\n")
def states(rng, p): return [c for c in run("log", "--format=%H", rng, "--", p).decode().split()]
def union(commits, p):
    u = set()
    for c in commits: u |= set(l.strip() for l in lines_at(c, p))
    return u
def main(p, oref, tref, dec=None):
    o, t = lines_at(oref, p), lines_at(tref, p)
    L = union(states("adf9c5bbf..refs/r2/stage1", p) + ["adf9c5bbf"], p)
    R = union(states("adf9c5bbf..refs/prov/route-history", p) + states("9a4880464^..refs/src/route", p) + ["9a4880464"], p)
    out, blocks = [], []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, o, t, autojunk=False).get_opcodes():
        if tag == "equal": out += o[i1:i2]; continue
        os_, ts = o[i1:i2], t[j1:j2]
        sig = lambda xs, S: [x for x in xs if x.strip() and x.strip() not in S]
        t_new = sig(ts, L); o_new = sig(os_, R)          # theirs text unknown to the lineage; ours text unknown to the route
        tcls = "empty" if not ts else ("ROUTE-UNIQUE" if t_new else "STALE")
        ocls = "empty" if not os_ else ("LINEAGE-ONLY" if o_new else "ROUTE-REMOVED")
        if tcls in ("STALE", "empty") and ocls in ("LINEAGE-ONLY", "empty"): d = "ours"
        elif tcls in ("ROUTE-UNIQUE", "empty") and ocls in ("ROUTE-REMOVED", "empty"): d = "theirs"
        elif tcls == "STALE" and ocls == "ROUTE-REMOVED": d = "ours"     # both sides' text known to the other: keep the lineage's newer state
        else: d = "MANUAL"
        k = f"{i1+1}"
        if dec and k in dec: d = dec[k]["take"]
        blocks.append({"oursLine": i1 + 1, "theirs": [j1 + 1, j2], "ours": os_, "theirsText": ts, "tcls": tcls, "ocls": ocls, "decision": d})
        if d == "ours": out += os_
        elif d == "theirs": out += ts
        elif d == "both": out += os_ + ts
        elif d == "theirs+ours": out += ts + os_
        elif isinstance(d, list): out += d
        else: out += [f"<<<<<<< MANUAL ours {i1+1}"] + os_ + ["======="] + ts + [">>>>>>> theirs"]
    return out, blocks
if __name__ == "__main__":
    p, oref, tref = sys.argv[1:4]; dec = json.load(open(sys.argv[4])) if len(sys.argv) > 4 else None
    out, blocks = main(p, oref, tref, dec)
    from collections import Counter
    print(p, dict(Counter(b["decision"] if isinstance(b["decision"], str) else "custom" for b in blocks)))
    for b in blocks:
        if b["decision"] == "MANUAL" or "-v" in sys.argv:
            print(f"--- MANUAL at ours {b['oursLine']} ({b['ocls']} / {b['tcls']})"); [print("  O|", x[:170]) for x in b["ours"][:14]]; [print("  T|", x[:170]) for x in b["theirsText"][:14]]

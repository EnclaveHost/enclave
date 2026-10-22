#!/usr/bin/env python3
"""Build overlay/ = the RECORDED live control tree (work/g4-control-merged-20261021/live-ref/live/control, symlinked file by
file, read-only) with the 101 frozen candidate files (work/lease-readiness-20261022/frozen-control.json) COPIED over it.
This is exactly the on-disk state after the control package is applied, assuming the recorded live snapshot is still current
(root must refresh it). Also writes regex import closures (static vs dynamic edges) for the processes that load control
files on minipc: the node agent (run-node.cmd -> agent.mjs) and the VM manager (run-shield.cmd -> manager/main.mjs).
Writes only inside this package directory."""
import hashlib, json, os, pathlib, re, shutil, sys
W = pathlib.Path(__file__).resolve().parents[3]          # .../wo/work
PKG = pathlib.Path(__file__).resolve().parents[1]
LIVE = W / "g4-control-merged-20261021/live-ref/live/control"
CAND = W / "lease-readiness-20261022/tree"
FROZEN = json.loads((W / "lease-readiness-20261022/frozen-control.json").read_text())["files"]
OV = PKG / "overlay"
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()

def build():
    if OV.exists(): shutil.rmtree(OV)
    for dp, dn, fn in os.walk(LIVE):
        rel = pathlib.Path(dp).relative_to(LIVE)
        (OV / rel).mkdir(parents=True, exist_ok=True)
        for f in fn: os.symlink(pathlib.Path(dp) / f, OV / rel / f)
    for r in FROZEN:
        p = OV / r["name"]; p.parent.mkdir(parents=True, exist_ok=True)
        if p.is_symlink() or p.exists(): p.unlink()
        data = (CAND / r["name"]).read_bytes(); assert hashlib.sha256(data).hexdigest() == r["sha256"], r["name"]
        p.write_bytes(data)

# import/export ... from '...' (static) | import('...') (dynamic) | import '...' (side effect, static)
STATIC = re.compile(r"""(?:^|[;\s}])(?:import|export)\s[^'"`;]*?\bfrom\s*(['"])(\.{1,2}/[^'"]+)\1|(?:^|[;\s])import\s*(['"])(\.{1,2}/[^'"]+)\3""", re.M)
DYN = re.compile(r"""\bimport\s*\(\s*(['"])(\.{1,2}/[^'"]+)\1\s*\)""")

def strip_comments(s):
    s = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), s, flags=re.S)
    return re.sub(r"(^|[^:'\"\\])//[^\n]*", r"\1", s)

def closure(root, entries):
    root = pathlib.Path(root); seen, missing, edges, todo = set(), set(), [], list(entries)
    while todo:
        rel = todo.pop()
        if rel in seen: continue
        f = root / rel
        if not f.is_file(): missing.add(rel); continue
        seen.add(rel)
        if f.suffix not in (".mjs", ".js", ".cjs"): continue
        src = strip_comments(f.read_text(errors="replace"))
        for kind, rx, g in (("static", STATIC, None), ("dynamic", DYN, 2)):
            for m in rx.finditer(src):
                spec = (m.group(2) or m.group(4)) if kind == "static" else m.group(2)
                t = os.path.normpath(os.path.join(os.path.dirname(rel), spec)).replace(os.sep, "/")
                edges.append([rel, t, kind]); todo.append(t)
    return sorted(seen), sorted(missing), edges

if __name__ == "__main__":
    build()
    frozen = {r["name"]: r for r in FROZEN}
    changed = sorted(n for n, r in frozen.items() if r["changed"])
    out = {"overlay": str(OV), "liveBase": str(LIVE), "frozenFiles": len(frozen), "changedFiles": changed}
    for label, root, entries in (("agentLive", LIVE, ["windows/node/agent.mjs"]), ("agentOverlay", OV, ["windows/node/agent.mjs"]),
                                 ("managerLive", LIVE, ["windows/vbslike/manager/main.mjs"]), ("managerOverlay", OV, ["windows/vbslike/manager/main.mjs"])):
        s, mi, e = closure(root, entries)
        dyn_only = sorted({t for _, t, k in e if k == "dynamic"} - {t for _, t, k in e if k == "static"})
        out[label] = {"files": s, "missing": mi, "edgeCount": len(e), "dynamicOnlyTargets": [t for t in dyn_only if t in s],
                      "changedInClosure": [n for n in changed if n in s]}
    # all 60 entries (the candidate tree's own closure, as recorded by control-closure.mjs) vs the agent's
    entries = (W / "g4-control-merged-20261021/tools/entries.txt").read_text().split()
    s60, mi60, _ = closure(OV, entries)
    out["all60Overlay"] = {"entries": len(entries), "files": len(s60), "missing": mi60}
    out["hashes"] = {n: sha(OV / n) for n in frozen}
    (PKG / "closure-regex.json").write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps({k: ({kk: (len(vv) if isinstance(vv, list) and kk == "files" else vv) for kk, vv in v.items()} if isinstance(v, dict) and k != "hashes" else (len(v) if k == "hashes" else v)) for k, v in out.items()}, indent=1))

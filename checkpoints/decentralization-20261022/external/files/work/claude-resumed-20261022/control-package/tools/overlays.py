#!/usr/bin/env python3
"""minimal/  = recorded live control + ONLY the REQUIRED manifest files (manifest.json group control+network-js);
mixed-agent/ = recorded live control + the changed files the OLD running agent can still import lazily after the swap
(what an old process would link if it first imports them in the swap->cutover window)."""
import importlib.util, json, os, pathlib, shutil
H = pathlib.Path(__file__).resolve().parent; P = H.parent
spec = importlib.util.spec_from_file_location("o", H / "overlay.py"); o = importlib.util.module_from_spec(spec); spec.loader.exec_module(o)
man = json.loads((P / "manifest.json").read_text())
def mk(name, files):
    d = P / name
    if d.exists(): shutil.rmtree(d)
    for dp, dn, fn in os.walk(o.LIVE):
        rel = pathlib.Path(dp).relative_to(o.LIVE); (d / rel).mkdir(parents=True, exist_ok=True)
        for f in fn: os.symlink(pathlib.Path(dp) / f, d / rel / f)
    for n in files:
        p = d / n; p.parent.mkdir(parents=True, exist_ok=True)
        if p.is_symlink() or p.exists(): p.unlink()
        p.write_bytes((P / "files" / n).read_bytes())
req = [f["name"] for f in man["deploy"] if f["group"] == "control"]
# model ACTUAL live (root's fresh snapshot), not the abe8626 reconstruction: keep pins whose bytes differ from the reconstruction
# get the candidate bytes (same sha), and files the snapshot shows absent are removed
snap = json.loads((o.W / "root-live-control-20261022/snapshot.json").read_text())["files"]
fix = [k["name"] for k in man["keep"] if k["name"] in snap and (o.LIVE / k["name"]).is_file() and o.sha(o.LIVE / k["name"]) != k["sha256"]]
gone = [n for n, h in snap.items() if h == "absent" and (o.LIVE / n).exists()]
def mk_live(name, files):
    mk(name, files)
    for n in fix:
        assert o.sha(o.CAND / n) == next(k["sha256"] for k in man["keep"] if k["name"] == n); p = P / name / n; p.unlink(); p.write_bytes((o.CAND / n).read_bytes())
    for n in gone: (P / name / n).unlink()
mk_live("minimal", req)
lazy = json.loads((P / "lazy-live.json").read_text())["agent"]["lazyChanged"]
new_only = [f["name"] for f in man["deploy"] if f["group"] == "control" and f["old"] == "absent"]
mk_live("mixed-agent", sorted(set(n for n in lazy if n in req) | set(new_only)))
print(json.dumps({"snapshotCorrections": fix, "snapshotAbsent": gone, "minimal": len(req), "mixedAgent": sorted(set(n for n in lazy if n in req) | set(new_only))}))

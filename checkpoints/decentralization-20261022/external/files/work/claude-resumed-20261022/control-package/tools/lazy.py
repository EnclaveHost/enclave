#!/usr/bin/env python3
"""Static-only (eagerly linked at process start) vs lazily imported modules of the RUNNING processes (recorded live tree),
intersected with the files this package changes. A lazy module first imported AFTER a swap would load new bytes into an old
process; this lists exactly those, with every dynamic import site."""
import importlib.util, json, pathlib, sys
H = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("o", H / "overlay.py"); o = importlib.util.module_from_spec(spec); spec.loader.exec_module(o)
changed = {r["name"] for r in o.FROZEN if r["changed"]}
out = {}
for proc, entry in (("agent", "windows/node/agent.mjs"), ("manager", "windows/vbslike/manager/main.mjs")):
    files, _, edges = o.closure(o.LIVE, [entry])
    eager, todo = set(), [entry]
    while todo:
        f = todo.pop()
        if f in eager: continue
        eager.add(f); todo += [b for a, b, k in edges if a == f and k == "static"]
    lazy = sorted(set(files) - eager)
    sites = {}
    for a, b, k in edges:
        if k == "dynamic" and b in lazy and b in changed:
            src = (o.LIVE / a).read_text(errors="replace").splitlines()
            spec_ = "./" + pathlib.PurePosixPath(b).name
            lines = [i + 1 for i, l in enumerate(src) if "import(" in l and pathlib.PurePosixPath(b).name in l]
            sites.setdefault(b, []).append({"importer": a, "lines": lines})
    out[proc] = {"eagerCount": len(eager), "lazy": lazy, "lazyChanged": sorted(x for x in lazy if x in changed), "sites": sites,
                 "eagerChanged": sorted(x for x in eager if x in changed)}
(H.parent / "lazy-live.json").write_text(json.dumps(out, indent=1) + "\n"); print(json.dumps(out, indent=1))

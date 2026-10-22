#!/usr/bin/env python3
"""Read-only: delta of STAGED-INVENTORY.json against another image's initramfs (app/ + opt/metal/ entries)."""
import gzip, hashlib, importlib.util, json, sys
W = "/home/steven/Documents/Codex/2026-10-18/wo/work"
spec = importlib.util.spec_from_file_location("o", f"{W}/resume-20261021/reconciled-candidate/metal/overlay-control-image.py"); o = importlib.util.module_from_spec(spec); spec.loader.exec_module(o)
img, label, inv_path = sys.argv[1], sys.argv[2], sys.argv[3]
base = {}
with gzip.open(img, "rb") as f:
    for key, name, fields, header in o.entries(f):
        d = o.exact(f, fields[6]); o.exact(f, -fields[6] % 4)
        if key.startswith("app/") or key.startswith("opt/metal/"): base[key] = hashlib.sha256(d).hexdigest()
d = json.load(open(inv_path)); inv = d["inventory"]
r = {"changed": {}, "added": {}, "same": []}
for gp, x in sorted(inv.items()):
    if gp.endswith(".manifest.json"): continue
    if base.get(gp) == x["sha256"]: r["same"].append(gp)
    elif gp in base: r["changed"][gp] = [base[gp][:8], x["sha256"][:8]]
    else: r["added"][gp] = x["sha256"][:8]
d["deltaVs" + label] = r; json.dump(d, open(inv_path, "w"), indent=1, sort_keys=True)
print(json.dumps({label: {"changed": r["changed"], "added": r["added"], "same": len(r["same"])}}, indent=1))

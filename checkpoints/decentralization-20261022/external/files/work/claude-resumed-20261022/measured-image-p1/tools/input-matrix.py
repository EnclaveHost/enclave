#!/usr/bin/env python3
"""Read-only: the measured-image input set (overlay-control-image.py's APP_FILES floor + supervisor.js import closure +
GUEST_FILES + optional guest helpers its gsup imports, plus the P1 platform-api trio build-image.mjs installs) computed from
the reconciled candidate's WORKING TREE with the candidate's own overlay tool functions, then each input hashed in every
reviewed tree we know. Writes the matrix JSON; reads nothing private; writes nothing outside this package."""
import hashlib, importlib.util, json, os, sys
W = "/home/steven/Documents/Codex/2026-10-18/wo/work"
TREES = {"candidate": f"{W}/resume-20261021/reconciled-candidate", "g4-composed": f"{W}/g4-control-merged-20261021/composed-tree",
         "g4-root-validation": f"{W}/g4-control-merged-20261021/root-validation-tree", "lease-readiness": f"{W}/lease-readiness-20261022/tree",
         "stage3-release": f"{W}/linux-combined-release/stage3/metal-e68067d24"}
spec = importlib.util.spec_from_file_location("o", f"{TREES['candidate']}/metal/overlay-control-image.py")
o = importlib.util.module_from_spec(spec); spec.loader.exec_module(o)
cand = TREES["candidate"]
def read(rel):
    p = os.path.join(cand, rel)
    return open(p, encoding="utf-8").read() if os.path.isfile(p) else None
files, packages = o.supervisor_closure(read, o.SUPERVISOR_ROOTS + o.APP_FILES)
app = list(dict.fromkeys(o.APP_FILES + files))
guest = list(o.GUEST_FILES)
texts = {f: read("metal/guest/" + f) for f in guest}
changed = True
while changed:
    changed = False
    for f in o.OPTIONAL_GUEST_FILES:
        if f not in guest and any(t and (("'./"+f+"'") in t or ('"./'+f+'"') in t) for t in texts.values()):
            guest.append(f); texts[f] = read("metal/guest/" + f); changed = True
P1_EXTRA = ["metal/guest/platform-api.bundle.mjs", "metal/guest/platform-api.bundle.mjs.manifest.json", "fixtures/tpm-roots.pem"]
inputs = ["app:" + a for a in app] + ["opt/metal:" + g for g in guest] + ["p1:" + x for x in P1_EXTRA]
def src(i):
    kind, rel = i.split(":", 1)
    return rel if kind == "app" else ("metal/guest/" + rel if kind == "opt/metal" else rel)
def sha(p):
    try:
        with open(p, "rb") as f: return hashlib.sha256(f.read()).hexdigest()
    except OSError: return None
rows = {}
for i in inputs:
    rows[i] = {t: (sha(os.path.join(root, src(i))) or "-")[:8] for t, root in TREES.items()}
m = {"inputs": len(inputs), "app": len(app), "guest": guest, "packages": sorted(set(packages)), "rows": rows}
json.dump(m, open(sys.argv[1], "w"), indent=1, sort_keys=True)
diff = {i: r for i, r in rows.items() if len({v for k, v in r.items() if k != "stage3-release" and v != "-"}) > 1}
print(json.dumps({"inputs": len(inputs), "appFiles": len(app), "guest": guest, "divergentAcrossReviewedTrees": len(diff)}))
for i, r in sorted(diff.items()): print(i, r)

#!/usr/bin/env python3
"""Stage the P1 measured-image INPUT candidate as real files (no build, no image, no measurement) and index the production
base for the delta. Layout = the guest paths: staged/app/<rel>, staged/opt/metal/<file>. Every source and result is
hash-asserted; nothing outside this package is written; the base image and all trees are only read.
  python3 tools/stage-inputs.py <out-dir>     (out-dir must not exist)"""
import gzip, hashlib, importlib.util, json, os, shutil, sys
W = "/home/steven/Documents/Codex/2026-10-18/wo/work"
CAND = f"{W}/resume-20261021/reconciled-candidate"
BASE = "/home/steven/enclave-prod/dist-sdshield-2857356cd"            # production b8376e15 (the overlay pipeline's read-only base)
R2 = f"{W}/claude-resumed-20261022/cutover-review/measured-carrier-integration-r2"
PC = f"{W}/claude-resumed-20261022/platform-activation/platform-carrier/out"
OVERRIDES = {   # guest path -> (source, sha256, why)
    "opt/metal/measured-control.mjs": (f"{R2}/src/metal/guest/measured-control.mjs", "f2648d65", "P1: reviewed carriers helper (patch 0ecce76f over 18f47214)"),
    "app/windows/node/host-admission.bundle.mjs": (f"{PC}/candidate.host-admission.bundle.mjs", "40e8ba71", "P1: carrier-capable host-admission (6bef372d lineage + carriers, no DO mirrors)"),
    "opt/metal/host-policy.bundle.mjs": (f"{PC}/candidate.metal-host-policy.bundle.mjs", "acfa1b00", "DECISION C4: same build/config (8ec507e0, no DO mirrors) as 40e8ba71; trees carry a19af83c (6422d065, 4 DO mirrors)"),
    "opt/metal/platform-api.bundle.mjs": (f"{R2}/bundle/new/platform-api.bundle.mjs", "c0a68797", "P1 as specified - BLOCKED C1: stale vs candidate (certs.js, lease-reader)"),
    "opt/metal/platform-api.bundle.mjs.manifest.json": (f"{R2}/bundle/new/platform-api.bundle.mjs.manifest.json", "211f9db2", "P1 manifest of c0a68797 (build-image.mjs reads it; not copied into the image itself)"),
    "opt/metal/fixtures/tpm-roots.pem": (f"{CAND}/relay/fixtures/tpm-roots.pem", "f72ea29a", "platform-api sidecar (manifest sidecars, unchanged)"),
}
def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""): h.update(c)
    return h.hexdigest()
out = sys.argv[1]; os.mkdir(out)
m = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "input-matrix.json")))
rows = {}
for i in m["rows"]:
    kind, rel = i.split(":", 1)
    if kind == "p1": continue
    gp = ("app/" + rel) if kind == "app" else ("opt/metal/" + rel)
    src = os.path.join(CAND, rel if kind == "app" else "metal/guest/" + rel)
    rows[gp] = (src, None, "candidate (== g4 composed / g4 root-validation / lease-readiness for this path)")
rows.update(OVERRIDES)
inv = {}
for gp, (src, want, why) in sorted(rows.items()):
    dst = os.path.join(out, gp); os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copyfile(os.path.realpath(src), dst)
    h = sha(dst)
    if want and not h.startswith(want): sys.exit(f"{gp}: {h[:8]} is not {want}")
    inv[gp] = {"sha256": h, "source": src.replace(W + "/", "work/"), "why": why}
links = [os.path.join(d, n) for d, ds, fs in os.walk(out) for n in ds + fs if os.path.islink(os.path.join(d, n))]
if links: sys.exit(f"symlinks staged: {links}")
# production base index (read-only) for the delta
spec = importlib.util.spec_from_file_location("o", f"{CAND}/metal/overlay-control-image.py"); o = importlib.util.module_from_spec(spec); spec.loader.exec_module(o)
base = {}
with gzip.open(f"{BASE}/initramfs.cpio.gz", "rb") as f:
    for key, name, fields, header in o.entries(f):
        d = o.exact(f, fields[6]); o.exact(f, -fields[6] % 4)
        if key.startswith("app/") or key.startswith("opt/metal/"): base[key] = hashlib.sha256(d).hexdigest()
delta = {"changed": [], "added": [], "sameAsProduction": []}
for gp, r in inv.items():
    if gp.endswith(".manifest.json"): continue                    # build-time metadata, not an image entry
    k = "sameAsProduction" if base.get(gp) == r["sha256"] else ("changed" if gp in base else "added")
    delta[k].append(gp)
json.dump({"inventory": inv, "deltaVsProductionB8376e15": delta, "baseEntriesIndexed": len(base)}, open(os.path.join(out, "..", "STAGED-INVENTORY.json"), "w"), indent=1, sort_keys=True)
print(json.dumps({"staged": len(inv), "changed": len(delta["changed"]), "added": len(delta["added"]), "same": len(delta["sameAsProduction"])}))

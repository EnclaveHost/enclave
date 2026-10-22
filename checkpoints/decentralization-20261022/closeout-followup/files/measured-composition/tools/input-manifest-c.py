#!/usr/bin/env python3
"""input-manifest.py <tree> <out.json>   (queue 512: it streams the 279 MB production base initramfs)

The TESTABLE INPUT MANIFEST of the --control direct image, computed WITHOUT building it: the tree's OWN overlay tool
(metal/overlay-control-image.py, imported) selects the installed set for the tree's capture commit exactly as overlay()
does (app_files + guest_files + platform_api_files), and its namespace/package checks run against the READ-ONLY production
base. Nothing is written except <out.json>. Compared with: the frozen P1 staged inventory (57 inputs), the production
base entries, and the KEPT image ed918e4b."""
import gzip, hashlib, importlib.util, json, os, subprocess, sys
W = "/home/steven/Documents/Codex/2026-10-18/wo/work"
BASE = "/home/steven/enclave-prod/dist-sdshield-2857356cd"
KEPT = f"{W}/linux-post-adoption-release/stage/dist-leasegas-deabf8f90"
P1 = f"{W}/claude-resumed-20261022/measured-image-p1/STAGED-INVENTORY.json"
sha = lambda b: hashlib.sha256(b).hexdigest()
def file_sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""): h.update(c)
    return h.hexdigest()

def index(o, p, wanted_pkgs=()):
    r, pk = {}, {}
    with gzip.open(p, "rb") as f:
        for key, name, fields, header in o.entries(f):
            h = hashlib.sha256(); size = fields[6]; keep = key in wanted_pkgs and size <= 1 << 20; buf = b""
            left = size
            while left:
                c = o.exact(f, min(left, 1 << 20)); h.update(c); left -= len(c)
                if keep: buf += c
            o.exact(f, -size % 4)
            r[key] = {"sha256": h.hexdigest(), "mode": oct(fields[1]), "nlink": fields[4]}
            if keep: pk[key] = buf
    return r, pk

def main(tree, out):
    tree = os.path.abspath(tree)
    spec = importlib.util.spec_from_file_location("o", f"{tree}/metal/overlay-control-image.py"); o = importlib.util.module_from_spec(spec); spec.loader.exec_module(o)
    env = {**os.environ, "GIT_OPTIONAL_LOCKS": "0"}
    commit = subprocess.check_output(["git", "rev-parse", "HEAD^{commit}"], cwd=tree, text=True, env=env).strip()
    m = json.load(open(f"{BASE}/manifest.json"))
    base_checks = {"initramfs": file_sha(f"{BASE}/initramfs.cpio.gz") == m["initramfs"]["sha256"], "kernel": file_sha(f"{BASE}/vmlinuz") == m["kernel"]["sha256"],
                   "cmdline": o.direct_cmdline(__import__("pathlib").Path(BASE), m)[0], "measurementFile": open(f"{BASE}/MEASUREMENT").read().strip()}
    installed_app, packages = o.app_files(commit, tree)
    paths = {**{"app/" + p: p for p in installed_app}, **{"opt/metal/" + p: "metal/guest/" + p for p in o.guest_files(commit, tree)}}
    pa_files, pa_record = o.platform_api_files(commit, tree)
    for k, v in pa_files.items(): o.place(paths, k, v, "platform API file")
    mcp_add, mcp_record = o.mcp_files(commit, tree, paths); paths.update(mcp_add)
    inputs = {k: {"source": v, "sha256": sha(o.committed(commit, tree, v))} for k, v in sorted(paths.items())}
    base, pk = index(o, f"{BASE}/initramfs.cpio.gz", {"app/node_modules/" + n + "/package.json" for n in packages})
    pkg_check = o.check_packages(packages, lambda n: pk.get("app/node_modules/" + n + "/package.json"))
    for k in inputs:                                                     # the overlay's own namespace rules, read-only
        if k in base and (not __import__("stat").S_ISREG(int(base[k]["mode"], 8)) or base[k]["nlink"] != 1): raise SystemExit(f"nonregular/hardlinked replacement {k}")
    kept, _ = index(o, f"{KEPT}/initramfs.cpio.gz")
    p1 = json.load(open(P1))["inventory"]
    def delta(ref, label):
        same = sorted(k for k in inputs if ref.get(k, {}).get("sha256") == inputs[k]["sha256"])
        changed = {k: [ref[k]["sha256"][:8], inputs[k]["sha256"][:8]] for k in inputs if k in ref and ref[k]["sha256"] != inputs[k]["sha256"]}
        added = {k: inputs[k]["sha256"][:8] for k in inputs if k not in ref}
        return {"vs": label, "same": len(same), "changed": changed, "added": added}
    p1_img = {k: v for k, v in p1.items() if not k.endswith(".manifest.json")}
    res = {"format": "measured-control-direct-input-manifest/1", "tree": tree, "commit": commit,
           "tool": {"path": "metal/overlay-control-image.py", "sha256": file_sha(f"{tree}/metal/overlay-control-image.py")},
           "base": {"dir": BASE, "manifestSha256": file_sha(f"{BASE}/manifest.json"), "initramfs": m["initramfs"], "kernel": m["kernel"], "checks": base_checks,
                    "entries": len(base)},
           "measuredCmdline": base_checks["cmdline"].replace("${MODE}", "snp"),
           "inputs": inputs, "count": len(inputs), "platformApiBundle": pa_record, "mcpBundle": mcp_record, "packagesFromBase": pkg_check,
           "deltaVsP1Staged": {**delta(p1_img, "measured-image-p1 STAGED-INVENTORY (frozen)"),
                               "p1Only": sorted(set(p1_img) - set(inputs))},
           "deltaVsProductionBase": delta(base, "production base b8376e15 (dist-sdshield-2857356cd)"),
           "deltaVsKept": delta(kept, "KEPT ed918e4b (dist-leasegas-deabf8f90)"),
           "deltaVsTreeB": delta({k: {"sha256": v["sha256"]} for k, v in json.load(open(os.path.join(os.path.dirname(tree), "out/b/INPUT-MANIFEST.json")))["inputs"].items()}, "tree-b input manifest (182cff58)")}
    json.dump(res, open(out, "w"), indent=1, sort_keys=True)
    print(json.dumps({"commit": commit, "count": len(inputs), "vsTreeB": res["deltaVsTreeB"], "vsP1": {k: (len(v) if isinstance(v, (dict, list)) else v) for k, v in res["deltaVsP1Staged"].items()},
                      "vsBase": {k: (len(v) if isinstance(v, dict) else v) for k, v in res["deltaVsProductionBase"].items()},
                      "packages": pkg_check, "cmdline": res["measuredCmdline"], "baseChecks": base_checks}, indent=1))

if __name__ == "__main__": main(*sys.argv[1:])

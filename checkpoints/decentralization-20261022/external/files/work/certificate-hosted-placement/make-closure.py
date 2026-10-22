#!/usr/bin/env python3
"""Standalone inventory of work/certificate-hosted-placement (read-only on every other tree).
Base = the byte copy of main's working tree (work/enclave, HEAD in base-head.txt, copied at base-time.txt; manifest
base-tree.sha256). Writes:
  closure-manifest.json  every modified/new file: base sha (= main at copy time), result sha, main NOW, and provenance
                         ("shield-patch" = the frozen work/shield-certificates result, "composed" = that patch on main's drifted
                         bytes, "hosted-placement" = new in this workspace, "generated" = rebuilt from source);
  patches/<path>.diff    unified diff per modified file against main's bytes at copy time;
  inventory.sha256       every closure artifact (patches, canary, logs, volume-parity-3way, new/modified files).
Exit 0 only when every base file is accounted for and main still holds the base bytes it was copied from."""
import difflib, hashlib, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
TREE, MAIN, SHIELD = os.path.join(HERE, "tree"), os.path.join(HERE, "../enclave"), os.path.join(HERE, "../shield-certificates")
def sha(p):
    try:
        with open(p, "rb") as f: return hashlib.sha256(f.read()).hexdigest()
    except FileNotFoundError: return None
base = {}
for line in open(os.path.join(HERE, "base-tree.sha256")):
    h, p = line.rstrip("\n").split("  ", 1); p = p[2:] if p.startswith("./") else p
    if "__pycache__/" not in p: base[p] = h
now = {}
for root, dirs, files in os.walk(TREE):
    dirs[:] = [d for d in dirs if d not in ("node_modules", "__pycache__")]
    for f in files:
        q = os.path.join(root, f)
        if os.path.islink(q): continue
        now[os.path.relpath(q, TREE)] = sha(q)
missing = sorted(set(base) - set(now))
if missing: sys.exit("base files missing from the tree: " + ", ".join(missing[:10]))
shield = json.load(open(os.path.join(SHIELD, "closure-manifest.json")))
shield_result = {x["path"]: x["result"] for x in shield["modified"]} | {x["path"]: x["sha256"] for x in shield["new"]}
GENERATED = {"relay/network-runtime.bundle.mjs", "relay/network-runtime.bundle.mjs.manifest.json"}
def provenance(p):
    if p in GENERATED: return "generated"
    if p in shield_result: return "shield-patch" if now[p] == shield_result[p] else "composed"
    return "hosted-placement"
modified = sorted(p for p in base if now[p] != base[p]); new = sorted(set(now) - set(base))
os.makedirs(os.path.join(HERE, "patches"), exist_ok=True)
out = {"base": {"head": open(os.path.join(HERE, "base-head.txt")).read().strip(), "copiedAt": open(os.path.join(HERE, "base-time.txt")).read().strip(),
                "manifestSha256": sha(os.path.join(HERE, "base-tree.sha256"))}, "modified": [], "new": []}
drift = []
for p in modified:
    mainNow = sha(os.path.join(MAIN, p))
    if mainNow != base[p]: drift.append(p)
    if p not in GENERATED:
        a = open(os.path.join(MAIN, p) if mainNow == base[p] else os.devnull, "rb").read().decode("utf-8", "replace").splitlines(keepends=True)
        b = open(os.path.join(TREE, p), "rb").read().decode("utf-8", "replace").splitlines(keepends=True)
        dp = os.path.join(HERE, "patches", p.replace("/", "__") + ".diff")
        open(dp, "w").write("".join(difflib.unified_diff(a, b, "a/" + p, "b/" + p, n=3)))
    out["modified"].append({"path": p, "base": base[p], "result": now[p], "mainNow": mainNow, "provenance": provenance(p)})
for p in new: out["new"].append({"path": p, "sha256": now[p], "provenance": provenance(p)})
out["mainDriftSinceCopy"] = drift
open(os.path.join(HERE, "closure-manifest.json"), "w").write(json.dumps(out, indent=1) + "\n")
inv = []
for d in ("patches", "canary", "logs", "volume-parity-3way"):
    for root, _, files in os.walk(os.path.join(HERE, d)):
        for f in sorted(files): q = os.path.join(root, f); inv.append(f"{sha(q)}  {os.path.relpath(q, HERE)}")
for f in ("closure-manifest.json", "base-tree.sha256", "base-time.txt", "base-head.txt", "make-closure.py", "apply-list.txt"): inv.append(f"{sha(os.path.join(HERE, f))}  {f}")
for p in new + modified: inv.append(f"{now[p]}  tree/{p}")
open(os.path.join(HERE, "inventory.sha256"), "w").write("\n".join(sorted(set(inv), key=lambda l: l[66:])) + "\n")
print(f"modified {len(modified)}, new {len(new)}, inventory {len(inv)}; main drift since copy: {drift or 'none'}")
for m in out["modified"]: print(f"  M {m['path']}  {m['base'][:12]} -> {m['result'][:12]}  [{m['provenance']}]")
for n in out["new"]: print(f"  A {n['path']}  {n['sha256'][:12]}  [{n['provenance']}]")
if drift: sys.exit(3)

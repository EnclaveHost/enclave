#!/usr/bin/env python3
"""READ-ONLY static staleness of every committed generated-artifact manifest, per tree (git objects only, nothing built).
A manifest input is any {relative path: 64-hex sha256} pair anywhere in the JSON (inputs maps, files lists, bundle pins);
'stale' = the tree's blob at that path hashes differently or is absent (gitignored generated inputs are reported, not judged).
Usage: manifest-staleness.py <git-dir> <ref>... -> JSON {manifest: {ref: {"stale": [...], "absent": [...], "inputs": n}}}"""
import hashlib, json, re, subprocess, sys
G = ["git", f"--git-dir={sys.argv[1]}"]; REFS = sys.argv[2:]
HEX = re.compile(r"^[0-9a-f]{64}$")
def run(*a): r = subprocess.run(G + list(a), capture_output=True); return r.stdout if r.returncode == 0 else None
MAN = re.compile(r"(\.MANIFEST\.json|\.bundle\.mjs\.manifest\.json|/packages/[^/]+\.package\.json)$")
def pairs(o, out):
    if isinstance(o, dict):
        for k, v in o.items():
            if isinstance(v, str) and HEX.match(v) and ("/" in k or k.endswith((".js", ".mjs", ".json", ".cjs"))): out[k] = v
            elif isinstance(v, dict) and isinstance(v.get("sha256"), str) and HEX.match(v["sha256"]) and ("/" in k or "." in k) and k not in ("artifact",): out[k] = v["sha256"]
            elif isinstance(v, (dict, list)): pairs(v, out)
            if isinstance(v, dict) and isinstance(v.get("path"), str) and isinstance(v.get("sha256"), str) and HEX.match(v["sha256"]): out[v["path"]] = v["sha256"]
    elif isinstance(o, list):
        for x in o:
            if isinstance(x, dict) and isinstance(x.get("path"), str) and isinstance(x.get("sha256"), str) and HEX.match(x["sha256"]): out[x["path"]] = x["sha256"]
            else: pairs(x, out)
res = {}
for ref in REFS:
    for m in [p for p in run("ls-tree", "-r", "--name-only", ref).decode().split("\n") if MAN.search(p) and not p.startswith(("test/fixtures/custodian", "isolation/"))]:
        try: j = json.loads(run("show", f"{ref}:{m}"))
        except Exception: continue
        ins = {}; pairs(j, ins); stale, absent = [], []
        for p, d in sorted(ins.items()):
            p2 = p[2:] if p.startswith("./") else p
            b = run("show", f"{ref}:{p2}")
            if b is None: absent.append(p2)
            elif hashlib.sha256(b).hexdigest() != d: stale.append(p2)
        res.setdefault(m, {})[ref] = {"inputs": len(ins), "stale": stale, "absent": absent}
json.dump(res, sys.stdout, indent=1)

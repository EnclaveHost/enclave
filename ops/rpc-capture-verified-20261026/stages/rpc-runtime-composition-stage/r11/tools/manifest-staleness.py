#!/usr/bin/env python3
"""READ-ONLY static staleness of every committed generated-artifact manifest in a git tree (git objects only; nothing built).
Inputs judged:
  * {repo path: sha256} pairs (inputs maps, sources maps, path/sha256 records): the repo path's CONTENT. A git symlink (mode
    120000) is resolved INSIDE the tree like the builders' readFileSync does: at most MAX_HOPS links, relative targets only;
    an absolute target, a target leaving the repository, a loop or a dangling link is a FAILURE (never "matches").
  * runtimeFiles / sidecars: {IMAGE path: {source: repo path, sha256}} - the image path is an install DESTINATION, never looked up
    in the tree; the SOURCE is resolved as above and must hash to sha256. A record without a source is a failure.
'stale' = content differs; 'absent' = no such tree path (gitignored generated inputs are reported, not judged here).
Usage: manifest-staleness.py <git-dir> <ref>...  -> JSON {manifest: {ref: {inputs, stale, absent, broken, runtime}}}"""
import hashlib, json, posixpath, re, subprocess, sys
HEX = re.compile(r"^[0-9a-f]{64}$"); MAX_HOPS = 8
MAN = re.compile(r"(\.MANIFEST\.json|\.bundle\.mjs\.manifest\.json|/packages/[^/]+\.package\.json)$")
class Tree:
    def __init__(self, git, ref):
        self.git, self.ref = git, ref
        out = subprocess.run(["git", f"--git-dir={git}", "ls-tree", "-r", "-z", ref], capture_output=True, check=True).stdout
        self.mode = {e.split(b"\t", 1)[1].decode(): e.split(b" ", 1)[0].decode() for e in out.split(b"\0") if e}
    def raw(self, p): return subprocess.run(["git", f"--git-dir={self.git}", "show", f"{self.ref}:{p}"], capture_output=True, check=True).stdout
    def content(self, p):
        """-> (bytes | None if absent, error | None). Bounded, in-tree symlink resolution."""
        p = posixpath.normpath(p)
        for _ in range(MAX_HOPS + 1):
            m = self.mode.get(p)
            if m is None: return None, None
            if m != "120000": return self.raw(p), None
            t = self.raw(p).decode()
            if t.startswith("/"): return None, f"{p}: absolute symlink target {t}"
            n = posixpath.normpath(posixpath.join(posixpath.dirname(p), t))
            if n == ".." or n.startswith("../"): return None, f"{p}: symlink leaves the repository ({t})"
            if n not in self.mode: return None, f"{p}: dangling symlink ({t})"
            p = n
        return None, f"symlink chain longer than {MAX_HOPS} hops (loop?)"
def pairs(o, out, side):
    if isinstance(o, dict):
        for k, v in o.items():
            if k in ("runtimeFiles", "sidecars") and isinstance(v, dict):
                for img, rec in v.items(): side.append((k, img, rec)); continue
                continue
            if isinstance(v, str) and HEX.match(v) and ("/" in k or k.endswith((".js", ".mjs", ".json", ".cjs"))): out[k] = v
            elif isinstance(v, dict) and isinstance(v.get("sha256"), str) and HEX.match(v["sha256"]) and ("/" in k or "." in k) and k != "artifact": out[k] = v["sha256"]
            elif isinstance(v, (dict, list)): pairs(v, out, side)
            if isinstance(v, dict) and isinstance(v.get("path"), str) and isinstance(v.get("sha256"), str) and HEX.match(v["sha256"]): out[v["path"]] = v["sha256"]
    elif isinstance(o, list):
        for x in o:
            if isinstance(x, dict) and isinstance(x.get("path"), str) and isinstance(x.get("sha256"), str) and HEX.match(x["sha256"]): out[x["path"]] = x["sha256"]
            else: pairs(x, out, side)
def audit(tree, m):
    j = json.loads(tree.raw(m)); ins, side = {}, []; pairs(j, ins, side)
    stale, absent, broken, runtime = [], [], [], []
    def judge(p, d, tag):
        b, err = tree.content(p[2:] if p.startswith("./") else p)
        if err: broken.append(f"{tag}{err}")
        elif b is None: absent.append(f"{tag}{p}")
        elif hashlib.sha256(b).hexdigest() != d: stale.append(f"{tag}{p}")
    for p, d in sorted(ins.items()): judge(p, d, "")
    for kind, img, rec in side:
        if not (isinstance(rec, dict) and isinstance(rec.get("source"), str) and isinstance(rec.get("sha256"), str) and HEX.match(rec["sha256"])):
            broken.append(f"{kind}[{img}]: no source/sha256 record"); continue
        runtime.append(f"{img} <- {rec['source']}"); judge(rec["source"], rec["sha256"], f"{kind}[{img}] source ")
    return {"inputs": len(ins), "runtime": runtime, "stale": stale, "absent": absent, "broken": broken}
if __name__ == "__main__":
    res = {}
    for ref in sys.argv[2:]:
        t = Tree(sys.argv[1], ref)
        for m in sorted(p for p in t.mode if MAN.search(p) and not p.startswith(("test/fixtures/custodian", "isolation/"))):
            try: res.setdefault(m, {})[ref] = audit(t, m)
            except json.JSONDecodeError: continue
    json.dump(res, sys.stdout, indent=1)

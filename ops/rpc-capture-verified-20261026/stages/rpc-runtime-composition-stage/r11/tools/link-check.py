#!/usr/bin/env python3
"""STATIC named-import/export link check over a git tree (git objects only; no module is executed or built).
For every tracked .mjs/.js (outside node_modules/vendor dirs): each `import {a, b as c} from './rel'` and `export {a} from './rel'`
must name an export of the resolved local module: `export function|class|const|let|var NAME`, `export {x, y as z}`,
`export * from './m'` (followed), `export default`. Generated bundles are read the same way (esbuild's `export { a as b }`).
Usage: link-check.py <git-dir> <ref> [--only PATH...] -> JSON list of {importer, target, missing}; exit 1 if any."""
import json, posixpath, re, subprocess, sys
G, REF = sys.argv[1], sys.argv[2]; ONLY = sys.argv[sys.argv.index("--only") + 1:] if "--only" in sys.argv else None
def run(*a): r = subprocess.run(["git", f"--git-dir={G}", *a], capture_output=True); return r.stdout.decode("utf8", "replace") if r.returncode == 0 else None
FILES = set(run("ls-tree", "-r", "--name-only", REF).split())
JS = [f for f in FILES if f.endswith((".mjs", ".js")) and "/node_modules/" not in f and not f.startswith(("node_modules/", "site/vendor/", "wasm/", "isolation/", "e2e/"))]
cache = {}
def src(p):
    if p not in cache: cache[p] = run("show", f"{REF}:{p}")
    return cache[p]
def strip(t): return re.sub(r"/\*.*?\*/", " ", re.sub(r"(?m)^\s*//.*$", "", t), flags=re.S)
def resolve(frm, s):
    b = posixpath.normpath(posixpath.join(posixpath.dirname(frm), s))
    for c in (b, b + ".mjs", b + ".js", b + "/index.mjs", b + "/index.js"):
        if c in FILES: return c
    return None
def names(clause):
    out = []
    for part in clause.split(","):
        part = part.strip()
        if not part: continue
        m = re.match(r"(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$", part)
        if m: out.append((m.group(1), m.group(2) or m.group(1)))
    return out
def exports(p, seen=None):
    seen = seen or set()
    if p in seen: return set(), False
    seen.add(p); t = src(p)
    if t is None: return set(), True
    t = strip(t); ex = set(); opaque = False
    ex |= set(re.findall(r"\bexport\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([\w$]+)", t))
    for d in re.findall(r"\bexport\s+(?:const|let|var)\s+\{([^}]*)\}", t): ex |= {n.split(":")[-1].strip() for n in d.split(",") if n.strip()}
    for c in re.findall(r"\bexport\s*\{([^}]*)\}(?!\s*from)", t): ex |= {b for a, b in names(c)}
    for c, s in re.findall(r"\bexport\s*\{([^}]*)\}\s*from\s*['\"]([^'\"]+)['\"]", t): ex |= {b for a, b in names(c)}
    if re.search(r"\bexport\s+default\b", t): ex.add("default")
    for s in re.findall(r"\bexport\s*\*\s*from\s*['\"]([^'\"]+)['\"]", t):
        if s.startswith("."):
            r = resolve(p, s)
            if r: e2, o2 = exports(r, seen); ex |= e2; opaque |= o2
            else: opaque = True
        else: opaque = True
    return ex, opaque
def main():
    bad = []
    for f in sorted(ONLY or JS):
        t = src(f)
        if t is None: continue
        t = strip(t)
        for clause, s in re.findall(r"\b(?:import|export)\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['\"](\.[^'\"]+)['\"]", t):
            r = resolve(f, s)
            if not r: bad.append({"importer": f, "target": s, "missing": ["<unresolved module>"]}); continue
            ex, opaque = exports(r)
            miss = [a for a, b in names(clause) if a not in ex]
            if miss and not opaque: bad.append({"importer": f, "target": r, "missing": miss})
    json.dump(bad, sys.stdout, indent=1); sys.exit(1 if bad else 0)
if __name__ == "__main__": main()

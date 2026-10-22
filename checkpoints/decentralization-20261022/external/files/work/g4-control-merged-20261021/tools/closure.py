#!/usr/bin/env python3
"""Static relative-import closure (import/export ... from, import(), side-effect import) of entry modules in a tree."""
import json, pathlib, re, sys
IMP = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}/[^'"]+)\1""")
def closure(root, entries):
    root = pathlib.Path(root).resolve(); seen, missing, edges = set(), [], []
    todo = [root / e for e in entries]
    while todo:
        f = todo.pop()
        rel = f.relative_to(root).as_posix() if str(f).startswith(str(root)) else str(f)
        if rel in seen: continue
        if not f.is_file(): missing.append(rel); continue
        seen.add(rel)
        if f.suffix not in (".mjs", ".js", ".cjs"): continue
        for m in IMP.finditer(f.read_text(errors="replace")):
            t = (f.parent / m.group(2)).resolve()
            try: tr = t.relative_to(root).as_posix()
            except ValueError: tr = "OUTSIDE:" + str(t)
            edges.append((rel, tr)); 
            if not tr.startswith("OUTSIDE:"): todo.append(t)
            else: missing.append(tr)
    return sorted(seen), sorted(set(missing)), edges
if __name__ == "__main__":
    s, mi, e = closure(sys.argv[1], sys.argv[2:]); print(json.dumps({"files": s, "missing": mi, "edges": e}))

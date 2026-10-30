#!/usr/bin/env python3
"""apply-resolutions.py <tree> <dir>: during `git merge --no-commit`, resolve EXACTLY the unmerged paths from <dir>/RESOLUTIONS.tsv
(path, rule ours|theirs|file|delete, sha256 of the resolved content or '-' for delete; rule file reads <dir>/files/<path>).
Every unmerged path needs one entry, no entry may be extra, and each result must hash to its reviewed sha256."""
import hashlib, pathlib, subprocess, sys
t, d = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]); g = lambda *a, **k: subprocess.run(["git", "-C", str(t), *a], check=True, capture_output=True, **k).stdout
un = set(p for p in g("diff", "--name-only", "--diff-filter=U", "-z").decode().split("\0") if p)
rows = [l.split("\t") for l in (d / "RESOLUTIONS.tsv").read_text().splitlines() if l and not l.startswith("#")]
res = {r[0]: r for r in rows}
if len(res) != len(rows) or set(res) != un: sys.exit(f"resolution set != unmerged set: missing {sorted(un - set(res))[:5]} extra {sorted(set(res) - un)[:5]}")
for p, (_, rule, want) in sorted(res.items()):
    if rule == "delete":
        if want != "-": sys.exit(f"{p}: delete needs '-'")
        g("rm", "-q", "--", p); continue
    data = {"ours": lambda: g("show", f":2:{p}"), "theirs": lambda: g("show", f":3:{p}"), "file": lambda: (d / "files" / p).read_bytes()}[rule]()
    if hashlib.sha256(data).hexdigest() != want: sys.exit(f"{p}: resolved content is not the reviewed {want[:12]}")
    (t / p).parent.mkdir(parents=True, exist_ok=True); (t / p).write_bytes(data); g("add", "--", p)
if g("diff", "--name-only", "--diff-filter=U"): sys.exit("unmerged paths remain")
print(f"resolved {len(res)} paths exactly as reviewed")

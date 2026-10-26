#!/usr/bin/env python3
"""Print the pin of a CLI-child supplement output dir exactly as check-compound-gate.py computes it:
sha256 over '<sha256>  <relative path>\\n' for every file, sorted by path; refuses symlinks. Usage: supplement-manifest.py DIR"""
import hashlib, pathlib, sys
d = pathlib.Path(sys.argv[1]); fs = sorted(p for p in d.rglob("*") if p.is_file() or p.is_symlink())
if any(p.is_symlink() for p in fs): sys.exit("symlink present: refused")
sha = lambda b: hashlib.sha256(b).hexdigest()
print(sha("".join(f"{sha(p.read_bytes())}  {p.relative_to(d)}\n" for p in fs).encode()), len(fs))

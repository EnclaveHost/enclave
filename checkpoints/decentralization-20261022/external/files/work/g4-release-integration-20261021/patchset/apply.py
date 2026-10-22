#!/usr/bin/env python3
"""apply.py TREE - write the 12 pinned runtime files into a COPY of the reconciled candidate. CAS per file: the tree's
current bytes must be PATCHSET.json's expectCandidate (or absent), else REFUSED (nothing written). Never touches git, never
commits, never builds. Prints one JSON line."""
import hashlib, json, os, pathlib, shutil, sys
H = pathlib.Path(__file__).resolve().parent; T = pathlib.Path(sys.argv[1]).resolve()
P = json.loads((H / 'PATCHSET.json').read_text())
s = lambda p: hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else 'absent'
bad = [e['path'] for e in P if s(T / e['path']) not in (e['expectCandidate'], e['pinned'])]
if bad: print(json.dumps({'decision': 'REFUSED: the tree is not the reviewed candidate at', 'paths': bad})); sys.exit(2)
for e in P:
    src = H / 'files' / e['path']; assert s(src) == e['pinned'], e['path']
    dst = T / e['path']; dst.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(src, dst)
ok = all(s(T / e['path']) == e['pinned'] for e in P)
print(json.dumps({'decision': 'applied' if ok else 'FAILED', 'files': len(P)})); sys.exit(0 if ok else 1)

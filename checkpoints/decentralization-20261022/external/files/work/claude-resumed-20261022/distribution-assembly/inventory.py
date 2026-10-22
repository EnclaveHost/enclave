#!/usr/bin/env python3
"""inventory.py - which exact bytes the 2026.10.22.1 assembly needs and where each comes from. Local, read-only.
For every release path: BASE (identical path+sha in the installed 2026.10.12.47 manifest 5b966e81, so the .47 base supplies
it) or OVERLAY (needs exact local bytes, found by sha256 in the indexed source dirs) or MISSING. Writes inventory.json."""
import hashlib, json, os, pathlib, sys

HERE = pathlib.Path(__file__).resolve().parent; W = next(p for p in HERE.parents if p.name == 'work')
M47 = W / 'g4-release-train-20261021/evidence/manifest-2026.10.12.47.json'
REQ = W / 'claude-resumed-20261022/distribution-closeout/required-release-files.v2.json'
TOP = {   # bundle top-level files the release must carry exactly (not Program Files paths except update/uninstall)
    'install-host.ps1': '1d1580c8f9ac22f6ec96a34cea8455853b21a21cff5214187710f3483953b721',   # r5, native-proven (51853)
    'update-host.ps1': '36f9e0d61afe58b77e566033ad1155d5c771252874f622592837c33e0a990112',    # installed by root 91208
}
INDEX = ['root-control-rpc-final-20261022/control-package/files', 'root-control-final-20261022/control-package/files',
         'g4-challenge-retry-package-20261022', 'g4-release-integration-20261021/tree', 'g4-release-integration-20261021/base-abe86262',
         'lease-readiness-20261022', 'resume-20261021/reconciled-candidate', 'g4-network-composition-20261021', 'g4-control-merged-20261021',
         'claude-resumed-20261022/dns-package-review/installer-review/src', 'claude-resumed-20261022/updater-first-hop-r4/src',
         'g4-release-train-20261021/main-src', 'custody-release-source-78acfcc6']
def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()

def main():
    m = json.loads(M47.read_text(encoding='utf-8-sig')); base = {e['path']: e for e in m['files']}
    req = json.loads(REQ.read_text())['required']; want = {**req, **TOP}
    need = {p: h for p, h in want.items() if not (p in base and base[p]['sha256'] == h)}
    idx = {}
    wanted = set(need.values())
    for d in INDEX:
        root = W / d
        if not root.exists(): continue
        for dp, dn, fn in os.walk(root):
            dn[:] = [x for x in dn if x not in ('node_modules', '.git', '__pycache__')]
            for f in fn:
                p = pathlib.Path(dp) / f
                try:
                    if p.is_symlink() or p.stat().st_size > 64 * 1024 * 1024: continue
                    h = sha(p)
                except OSError: continue
                if h in wanted: idx.setdefault(h, str(p.relative_to(W)))
    rows = {}
    for p, h in sorted(want.items()):
        if p in base and base[p]['sha256'] == h: rows[p] = {'sha256': h, 'class': 'BASE'}
        elif h in idx: rows[p] = {'sha256': h, 'class': 'OVERLAY', 'source': idx[h], 'inBase': p in base}
        else: rows[p] = {'sha256': h, 'class': 'MISSING', 'inBase': p in base}
    out = {'base': {'manifest': str(M47.relative_to(W)), 'sha256': sha(M47), 'version': m['version'], 'files': len(base)},
           'required': {'file': str(REQ.relative_to(W)), 'sha256': sha(REQ)}, 'rows': rows,
           'counts': {c: sum(1 for r in rows.values() if r['class'] == c) for c in ('BASE', 'OVERLAY', 'MISSING')}}
    (HERE / 'inventory.json').write_text(json.dumps(out, indent=1) + '\n')
    print(json.dumps(out['counts'])); [print('MISSING', p, r['sha256'][:8], 'inBase' if r['inBase'] else 'new') for p, r in rows.items() if r['class'] == 'MISSING']
    return 0

if __name__ == '__main__': sys.exit(main())

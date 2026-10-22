# Generated-bundle consistency in the candidate: recorded bundle/sidecar sha256 and every recorded input sha256 vs the
# candidate's bytes (node_modules inputs vs main's installed node_modules, read-only). Writes manifest-check.json.
import hashlib, json, os, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent; C = HERE.parent/'reconciled-candidate'; M = HERE.parents[1]/'enclave'
h = lambda p: hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None
res = {}
for mf in sorted(C.glob('**/*.manifest.json')):
    if 'node_modules' in mf.parts: continue
    d = json.load(open(mf)); rel = str(mf.relative_to(C))
    r = {'bundle': d.get('bundle'), 'bundleMatches': h(C/d['bundle']) == d['sha256'], 'inputs': len(d.get('inputs', {})), 'staleInputs': [], 'nodeModulesMismatch': 0, 'sidecarsMatch': True}
    for p, s in d.get('inputs', {}).items():
        if 'node_modules/' in p:
            r['nodeModulesMismatch'] += h(M/p) != s
        elif h(C/p) != s: r['staleInputs'].append(p)
    for k, v in (d.get('sidecars') or {}).items():
        want = v if isinstance(v, str) else v.get('sha256')
        if h(C/k) != want: r['sidecarsMatch'] = False
    res[rel] = r
    print('MANIFEST', rel, 'bundle-matches' if r['bundleMatches'] else 'BUNDLE-DIFFERS', 'inputs', r['inputs'], 'stale', r['staleInputs'], 'node_modules-mismatch', r['nodeModulesMismatch'], 'sidecars-ok' if r['sidecarsMatch'] else 'SIDECAR-DIFFERS')
json.dump(res, open(HERE/'manifest-check.json', 'w'), indent=1)

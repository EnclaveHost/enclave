#!/usr/bin/env python3
"""compose-required.py - the files the NEXT minipc Windows release must carry exactly (required-release-files.v2.json).
Local, deterministic, read-only inputs. Sources, in precedence order (a later source never overrides an earlier one; a
disagreement is reported in conflicts and is not resolved here):
  1. root's APPLIED control package (root-control-rpc-final-20261022/control-package/manifest.json: deploy[].new, 18 control
     + 1 network, applied 03:30:30Z / 02:21:04Z per helper/runs and root-control-final runs) - what minipc now has on disk;
  2. the same package's keep[] (live hashes from root's 01:44:55Z snapshot) - live files the package left unchanged;
  3. the update chain installed or reviewed for it: update-host.ps1 36f9e0d6 (installed by root 91208, 03:28:34Z);
  4. required-release-files.json ecbe8e29 (g4-release-train) for paths 1-3 do not cover, marked needsFreshLiveRead.
install-host.ps1 is NOT a Program Files file (the bundle runs it); release-gate.py pins it inside the zip instead.
"""
import hashlib, json, pathlib, sys

HERE = pathlib.Path(__file__).resolve().parent
W = next(p for p in HERE.parents if p.name == 'work')
PKG = W / 'root-control-rpc-final-20261022/control-package/manifest.json'
OLD = W / 'g4-release-train-20261021/required-release-files.json'
PINS = {PKG: None, OLD: 'ecbe8e294a5e53a96a2a4a69602dc2a1fb86348c7394fc5551fed15f0a70686c'}
PF = 'C:\\Program Files\\Enclave\\'
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()

def rel(target):
    if not target.startswith(PF): raise SystemExit(f'target outside Program Files\\Enclave: {target}')
    return target[len(PF):].replace('\\', '/')

def main():
    for p, h in PINS.items():
        if h and sha(p) != h: raise SystemExit(f'{p} is not {h}')
    m = json.loads(PKG.read_text()); old = json.loads(OLD.read_text())
    req, src, conflicts = {}, {}, []
    def put(path, h, source, extra=None):
        if path in req:
            if req[path] != h: conflicts.append({'path': path, 'kept': [req[path], src[path]['source']], 'other': [h, source]})
            return
        req[path] = h; src[path] = {'source': source, **(extra or {})}
    for e in m['deploy']: put(rel(e['target']), e['new'], 'control-package deploy (applied)', {'group': e['group'], 'how': e['how']})
    for e in m['keep']: put(rel(e['target']), e['sha256'], 'control-package keep (live snapshot 01:44:55Z)')
    put('update-host.ps1', '36f9e0d61afe58b77e566033ad1155d5c771252874f622592837c33e0a990112', 'installed by root 91208 (first hop r4)')
    for path, h in sorted(old.items()): put(path, h, 'required-release-files ecbe8e29', {'needsFreshLiveRead': True})
    out = {'format': 'enclave-required-release-files/v2', 'inputs': {str(PKG.relative_to(W)): sha(PKG), str(OLD.relative_to(W)): sha(OLD)},
           'required': dict(sorted(req.items())), 'sources': dict(sorted(src.items())), 'conflicts': conflicts,
           'counts': {'required': len(req), 'conflicts': len(conflicts), 'needsFreshLiveRead': sum(1 for v in src.values() if v.get('needsFreshLiveRead'))}}
    (HERE / 'required-release-files.v2.json').write_text(json.dumps(out, indent=1) + '\n')
    # check-release.py reads a flat {path: sha256}
    (HERE / 'required-release-files.v2.flat.json').write_text(json.dumps(out['required'], indent=1, sort_keys=True) + '\n')
    print(json.dumps(out['counts'])); [print('CONFLICT', json.dumps(c)) for c in conflicts]
    return 0

if __name__ == '__main__': sys.exit(main())

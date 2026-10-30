#!/usr/bin/env python3
"""p2 helper: does a node_modules root hold exactly the bytes a committed bundle manifest recorded? -> counts per manifest.
usage: p2-nm-match.py REPO COMMIT PREFIX NM_DIR  (PREFIX = 'node_modules' or 'relay/node_modules')"""
import hashlib, json, subprocess, sys, os
repo, commit, prefix, nm = sys.argv[1:5]
for man in ['metal/guest/lease-gas-conduit.bundle.mjs.manifest.json', 'metal/guest/platform-api.bundle.mjs.manifest.json', 'metal/guest/mcp-server.bundle.mjs.manifest.json']:
    ins = json.loads(subprocess.run(['git', '-C', repo, 'cat-file', 'blob', f'{commit}:{man}'], check=True, capture_output=True).stdout)['inputs']
    want = {k: v for k, v in ins.items() if k.startswith(prefix + '/')}
    ok = bad = miss = 0; firstbad = []
    for k, h in want.items():
        p = os.path.join(nm, k[len(prefix) + 1:])
        if not os.path.isfile(p): miss += 1; firstbad.append('missing ' + k) if len(firstbad) < 3 else None; continue
        if hashlib.sha256(open(p, 'rb').read()).hexdigest() == h: ok += 1
        else: bad += 1; firstbad.append('differs ' + k) if len(firstbad) < 3 else None
    print(f"{man.split('/')[-1]} {prefix}: recorded {len(want)} match {ok} differ {bad} missing {miss} {firstbad}")

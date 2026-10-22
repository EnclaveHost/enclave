#!/usr/bin/env python3
"""Release provenance (read-only): the reviewed-candidate challenge replica release manifest aa1ebdb5 vs the sources it
records, today's canonical main (work/enclave) and the G3/G4 trees. Which recorded inputs still match, which drifted."""
import hashlib, json, os, sys
W = '/home/steven/Documents/Codex/2026-10-18/wo/work'
M = f'{W}/certificate-release-prep/release/dist/dns.mjs.manifest.json'
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest() if os.path.isfile(p) else None
assert sha(M) == 'aa1ebdb591e15866d30061ae41704c6532ff6ec03a882f920c99058a3bd41bbf'
m = json.load(open(M)); d = f'{W}/certificate-release-prep/release/dist'
out = {'manifest': 'aa1ebdb5', 'files': {f: sha(f'{d}/{f}') for f in ('dns.mjs', 'network-runtime.bundle.mjs', 'challenge-host.mjs')},
       'manifestSays': {'dns.mjs': m['sha256'], 'runtime': m['runtimeBundleSha256'], 'host': m['host']['sha256']},
       'copiesIdentical': {x: sha(f'{W}/certificate-release-prep/release/{x}/dns.mjs.manifest.json') == sha(M) for x in ('a', 'b')}, 'trees': {}}
for name, root in (('prep-tree', f'{W}/certificate-release-prep/tree'), ('canonical-main', f'{W}/enclave'), ('g3', f'{W}/host-service-tls-20261021/g3-final-package/tree'), ('g4-composition', f'{W}/challenge-host-tls-20261021/tree')):
    for key, inputs in (('dns.mjs', m['inputs']), ('challenge-host.mjs', m['host']['inputs'])):
        diff = [i['path'] for i in inputs if sha(os.path.join(root, i['path'])) != i['sha256']]
        out['trees'].setdefault(name, {})[key] = {'inputs': len(inputs), 'differ': len(diff), 'paths': diff[:12]}
    out['trees'][name]['runtimeBundleNow'] = (sha(os.path.join(root, 'relay/network-runtime.bundle.mjs')) or 'absent')[:8]
json.dump(out, open('release-provenance.json', 'w'), indent=1); print(json.dumps(out, indent=1))

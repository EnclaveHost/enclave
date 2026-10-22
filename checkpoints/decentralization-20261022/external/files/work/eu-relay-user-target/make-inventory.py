#!/usr/bin/env python3
# Writes inventory.json: sha256 of every reviewed file in this workspace (scripts, templates, tests, mocks, docs), the frozen
# release (id, archive sha256, relay package pin, gate sha256, provenance) and the test evidence logs. Reads nothing else.
import hashlib, json, os, datetime, glob
H = os.path.dirname(os.path.abspath(__file__))
def h(p): return hashlib.sha256(open(p, 'rb').read()).hexdigest()
files = {}
for d in ['user', 'source', 'files', 'config', 'test']:
    for root, _, fs in os.walk(os.path.join(H, d)):
        for f in sorted(fs): p = os.path.join(root, f); files[os.path.relpath(p, H)] = h(p)
for f in ['build-release.mjs', 'run-build2.sh', 'run-unit.sh', 'run-fixtures.sh', 'RUNBOOK.md', 'make-inventory.py']:
    if os.path.exists(os.path.join(H, f)): files[f] = h(os.path.join(H, f))
tars = glob.glob(os.path.join(H, 'release', '*.tar'))
assert len(tars) == 1, tars
rid = os.path.basename(tars[0])[:-4]
m = json.load(open(os.path.join(H, 'release', rid, 'RELEASE.json')))
logs = {os.path.relpath(p, H): h(p) for p in sorted(glob.glob(os.path.join(H, 'logs', '*.log')) + glob.glob(os.path.join(H, 'logs', '*.json')) + glob.glob(os.path.join(H, 'evidence', '*.json')))}
inv = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
       'status': 'prepared; NOT installed, NOT started; root owns the switch',
       'release': {'id': rid, 'archive': f'release/{rid}.tar', 'archiveSha256': h(tars[0]), 'files': len(m['files']),
                   'relayPackagePin': m['relayPackage']['pin'], 'relayBundleSha256': m['relayPackage']['bundleSha256'], 'gateSha256': m['gateSha256'],
                   'packages': {k.replace('node_modules/', ''): v['version'] for k, v in m['packages'].items()},
                   'builtFrom': {'head': m['builtFrom']['head'], 'sourcesNotCommitted': m['builtFrom']['sourcesNotCommitted'], 'symlinkedInRepo': m['builtFrom'].get('symlinkedInRepo'),
                                 'sources': m['builtFrom']['sources']}},
       'files': files, 'evidence': logs}
json.dump(inv, open(os.path.join(H, 'inventory.json'), 'w'), indent=1)
print(h(os.path.join(H, 'inventory.json')))

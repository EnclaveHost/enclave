"""frozen-0931 (batch identifier = this batch's start, 2026-10-23T09:31Z): which INSTALLED NucBox baseline source files are not
already in the pushed checkpoint's history? Read-only. For every repo-source input (node_modules excluded: npm packages, recorded
by the input manifests) of the installed builds - privacy-agent cfb69370 (1938 inputs), windows-circuit-worker 13ce44f1, host-
service-ingress c952dce4 - plus the installed control SOURCE files (root-control-final files, keeper host/chain) and the installed
tree's own reviewed challenge tests, compute the git blob id of the exact bytes and test reachability from cadf0ebb.
Writes frozen-0931-work/installed-unpreserved.json."""
from pathlib import Path
import hashlib, json, subprocess
W = Path(__file__).resolve().parents[2]
CK = W / 'source-checkpoint-20261022/main-repo'; HEAD = 'cadf0ebb83338d847ef1cb5d3f14a64fe7560098'
G4 = W / 'g4-network-composition-20261021'; RT = W / 'g4-challenge-retry-package-20261022'; RC = W / 'root-control-final-20261022/control-package/files'
R2 = W / 'g4-config-independent-review-20261021/revision2/network-tree'
def blob(b): return hashlib.sha1(b'blob %d\0' % len(b) + b).hexdigest()
def sha(b): return hashlib.sha256(b).hexdigest()
reach = set(l.split()[0] for l in subprocess.run(['git', '-C', str(CK), 'rev-list', '--objects', HEAD], check=True, capture_output=True, text=True).stdout.splitlines())
items = {}   # logical path -> (file, provenance)
man = json.loads((RT / 'candidate/privacy-agent.mjs.inputs.json').read_text())
for p, h in man.items():
    if 'node_modules/' in p: continue
    f = (RT / 'src' / p) if p in ('network/challenge-replica-host.mjs', 'network/enclave-network-host.mjs') else (G4 / 'src' / p)
    items[p] = (f, 'privacy-agent cfb69370 input (g4-challenge-retry-package-20261022/candidate/privacy-agent.mjs.inputs.json)', h)
for name in ('windows-circuit-worker.mjs', 'host-service-ingress.mjs'):
    for p, h in json.loads((G4 / 'out/g4' / (name + '.inputs.json')).read_text()).items():
        if 'node_modules/' in p or p in items: continue
        items[p] = (G4 / 'src' / p, f'{name} input (g4-network-composition-20261021/out/g4/{name}.inputs.json)', h)
for p in ('windows/node/agent.mjs', 'windows/node/network-enroll.mjs', 'network/host-service-transport.mjs', 'network/host-service-names.mjs',
          'network/wallet-admission.mjs', 'windows/node/appzone.mjs', 'windows/node/hvcert.mjs', 'windows/node/shield-sessions.mjs',
          'windows/node/shield-startup.mjs', 'windows/node/shield-verdict.mjs'):
    f = RC / p
    items['control/' + p] = (f, 'installed control file (root-control-final-20261022/control-package/files)', None)
for t in ('challenge-replica-supervise', 'challenge-replica-host', 'challenge-front-managed'):
    p = f'test/{t}.test.mjs'; items['tests/' + p] = (R2 / p, 'installed tree reviewed test (g4-config-independent-review-20261021/revision2/network-tree)', None)
rows = []
for p, (f, prov, want) in sorted(items.items()):
    b = f.resolve().read_bytes(); s = sha(b)
    assert want is None or want == s, (p, 'bytes differ from the build manifest')
    rows.append({'path': p, 'file': str(f.relative_to(W)), 'sha256': s, 'gitBlob': blob(b), 'bytes': len(b), 'provenance': prov,
                 'inCheckpointHistory': blob(b) in reach})
missing = [r for r in rows if not r['inCheckpointHistory']]
out = {'checkpointHead': HEAD, 'checked': len(rows), 'alreadyPreserved': len(rows) - len(missing), 'notPreserved': missing,
       'note': 'node_modules inputs are not source of this project (npm packages); they are recorded by sha256 in the input manifests'}
(Path(__file__).parent / 'frozen-0931-work/installed-unpreserved.json').write_text(json.dumps(out, indent=1) + '\n')
print(json.dumps({'checked': len(rows), 'notPreserved': [(r['path'], r['sha256'][:8], r['bytes']) for r in missing]}, indent=0))

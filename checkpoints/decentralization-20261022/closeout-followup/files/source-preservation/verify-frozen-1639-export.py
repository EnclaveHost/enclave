"""Prove the frozen-1639 patches reproduce every recorded tree, offline, from PUSHED checkpoint material (b995a73b), in throwaway
bare repos with a temporary index ("1639" = the batch start 2026-10-23T16:39Z, an identifier). Bases are rebuilt from the stored patch
chains of the earlier exports (frozen-0331..1517); merges are stored diffs vs their first parent; emptyAfterExclusion commits must leave
the derived tree unchanged. a-cv and e-gen-report reproduce DERIVATIVE trees only.
Writes source-preservation/frozen-1639-export/REPRODUCE-CHECK.txt."""
from pathlib import Path
import json, os, subprocess, tempfile
root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
checkpoint = root / 'work/source-checkpoint-20261022/main-repo'
CK = 'b995a73b6b3ae51d1812607da0e4d8ea6fd32f6e'
STORED = 'checkpoints/decentralization-20261022/closeout-followup/files/'
out = base / 'source-preservation/frozen-1639-export'
inv = json.loads((out / 'INVENTORY.json').read_text())
EMPTY = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
report = []
def stored(rel): return subprocess.run(['git', '-C', str(checkpoint), 'show', f'{CK}:{STORED}{rel}'], check=True, capture_output=True).stdout
J = lambda rel: json.loads(stored(rel))
X = lambda n: f'source-preservation/frozen-{n}-export/'
f331, f410, f420, f630, f745, f830, f931, f1118, f1339, f1517 = (J(X(n) + 'INVENTORY.json') for n in ('0331', '0410', '0420', '0630', '0745', '0830', '0931', '1118', '1339', '1517'))
bevm = J('rpc-base-evm-export/INVENTORY.json')
P = lambda prefix, side: [prefix + p['file'] for p in side['patches']]
A_CHAIN = (P('rpc-base-evm-export/', bevm['enclave']) + P(X('0331'), f331['sides']['a-verifier-authority']) + P(X('0410'), f410['sides']['a-reth-e2e'])
           + P(X('0420'), f420['sides']['a-policy-callers']) + P(X('0630'), f630['sides']['a-native-relay']))
aw = f830['sides']['a-windows']; A0 = bevm['enclave']['base']
s, d = inv['sides'], inv['derivatives']
E1517 = f1517['sides']['e-prod']; AR = f1517['derivatives']['a-receipts']
BASES = {'e-gen': (A0, A_CHAIN + P(X('0830'), aw)[:4] + P(X('0931'), f931['sides']['s-browser']) + P(X('1339'), f1339['sides']['e-wallet']) + P(X('1517'), E1517), E1517['headTree']),
         'root-ram96c': (None, P(X('1118'), f1118['sides']['root-ram96']) + P(X('1339'), f1339['sides']['root-ram96b']), f1339['sides']['root-ram96b']['headTree']),
         'root-api-mcp2': (None, P(X('1517'), f1517['sides']['root-api-mcp']), f1517['sides']['root-api-mcp']['headTree']),
         'a-cv': (A0, A_CHAIN + P(X('0830'), aw) + P(X('0931'), f931['sides']['a-parity']) + P(X('1339'), f1339['derivatives']['a-gaps']) + P(X('1517'), AR), AR['headTree'])}
for k in {**s, **d}:
    BASES.setdefault(k, (None, [], EMPTY))
assert E1517['head'] == s['e-gen']['base'] and f1339['sides']['root-ram96b']['head'] == s['root-ram96c']['base']
assert f1517['sides']['root-api-mcp']['head'] == s['root-api-mcp2']['base'] and AR['head'] == d['a-cv']['base']
def check(name, side):
    start, steps, want = BASES[name]
    with tempfile.TemporaryDirectory(prefix='frozen-1639-verify-') as tmp:
        tmp = Path(tmp)
        env = {**os.environ, 'GIT_DIR': str(tmp / 'r.git'), 'GIT_INDEX_FILE': str(tmp / 'index'), 'GIT_CONFIG_NOSYSTEM': '1'}
        run = lambda *a, **kw: subprocess.run(['git', '-c', 'gc.auto=0', *a], env=env, cwd=tmp, check=True, capture_output=True, **kw)
        run('init', '-q', '--bare', str(tmp / 'r.git')); (tmp / 'r.git/objects/info/alternates').write_text(f'{checkpoint}/.git/objects\n')
        run('read-tree', start) if start else run('read-tree', '--empty')
        for i, what in enumerate(steps):
            pf = tmp / f'prior-{i}.patch'; pf.write_bytes(stored(what)); run('apply', '--cached', '--whitespace=nowarn', str(pf))
        tree = run('write-tree').stdout.decode().strip(); ok = tree == want
        report.append(f"{name} base rebuilt from {(start or 'empty')[:9]} + {len(steps)} stored patch(es) in {CK[:9]}: tree {tree} {'OK' if ok else 'MISMATCH want ' + want}")
        patches = iter(side['patches'])
        for commit in side['commits']:
            if commit.get('emptyAfterExclusion'):     # touches only excluded paths: no patch; the derived tree must not change
                good = tree == commit['tree']; ok &= good
                report.append(f"{name} {commit['commit'][:9]}: excluded-paths-only commit, derived tree {tree} {'unchanged OK' if good else 'MISMATCH want ' + commit['tree']}")
                continue
            run('apply', '--cached', '--whitespace=nowarn', str(out / next(patches)['file']))
            tree = run('write-tree').stdout.decode().strip(); good = tree == commit['tree']; ok &= good
            report.append(f"{name} {commit['commit'][:9]}: tree {tree} {'OK' if good else 'MISMATCH want ' + commit['tree']}")
        assert next(patches, None) is None, f'{name}: unused patches'
        return ok and tree == side['headTree']
results = {k: check(k, v) for k, v in {**s, **d}.items()}
for k in d:
    report.append(f'{k} trees are the ORIGINAL trees minus {d[k]["excluded"]} (head original {d[k]["originalHeadTree"][:9]}); exact originals NOT reproduced')
report.append('RESULT ' + ', '.join(f'{k} reproduced: {v}' for k, v in results.items()))
(out / 'REPRODUCE-CHECK.txt').write_text('\n'.join(report) + '\n'); print('\n'.join(report))
raise SystemExit(0 if all(results.values()) else 1)

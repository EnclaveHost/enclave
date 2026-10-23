"""Prove the frozen-1339 patches reproduce every recorded tree, offline, from PUSHED checkpoint material (476c589b), in throwaway
bare repos with a temporary index ("1339" = the batch start 2026-10-23T13:39Z, an identifier):
* 14d1e495 (s-role, f-baseline)  = frozen-0830 f-final recipe + frozen-0931 f-rpc-closure patches
* fad657bc (b-launch)            = the 493ee9ee tree + frozen-0630 d-linux-fec + frozen-0745 d-linux-carrier patches
* 349318a0 (e-wallet)            = frozen-0830 a-windows chain (first 4 patches, e820e240) + frozen-0931 s-browser patches
* e32dd607 (a-gaps, EXACT)       = frozen-0830 a-windows recipe + frozen-0931 a-parity patches
* dd7e7af8 (root-ram96b)         = empty + frozen-1118 root-ram96 patches
* the rest: root commits from the empty tree. a-gaps and e-report reproduce DERIVATIVE trees only.
Writes source-preservation/frozen-1339-export/REPRODUCE-CHECK.txt."""
from pathlib import Path
import json, os, subprocess, tempfile
root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
checkpoint = root / 'work/source-checkpoint-20261022/main-repo'
CK = '476c589bb35abd10efd830863b042e8801c18ef0'
STORED = 'checkpoints/decentralization-20261022/closeout-followup/files/'
out = base / 'source-preservation/frozen-1339-export'
inv = json.loads((out / 'INVENTORY.json').read_text())
EMPTY = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
report = []
def stored(rel): return subprocess.run(['git', '-C', str(checkpoint), 'show', f'{CK}:{STORED}{rel}'], check=True, capture_output=True).stdout
J = lambda rel: json.loads(stored(rel))
X = lambda n: f'source-preservation/frozen-{n}-export/'
f331, f410, f420, f630, f745, f830, f931, f1118 = (J(X(n) + 'INVENTORY.json') for n in ('0331', '0410', '0420', '0630', '0745', '0830', '0931', '1118'))
ncodec = J('rpc-native-codec-export/INVENTORY.json'); bevm = J('rpc-base-evm-export/INVENTORY.json')
P = lambda prefix, side: [prefix + p['file'] for p in side['patches']]
F_CHAIN = (P('rpc-native-codec-export/', ncodec['sides']['c']) + P(X('0410'), f410['sides']['c-host-services-cold'])
           + P(X('0630'), f630['sides']['c-carriers']) + P(X('0830'), f830['merge']) + P(X('0931'), f931['sides']['f-rpc-closure']))
A_CHAIN = (P('rpc-base-evm-export/', bevm['enclave']) + P(X('0331'), f331['sides']['a-verifier-authority']) + P(X('0410'), f410['sides']['a-reth-e2e'])
           + P(X('0420'), f420['sides']['a-policy-callers']) + P(X('0630'), f630['sides']['a-native-relay']))
aw = f830['sides']['a-windows']
N493 = f630['sides']['d-linux-fec']['base']
s, d = inv['sides'], inv['derivatives']
BASES = {'s-role': (ncodec['sides']['c']['base'], F_CHAIN, f931['sides']['f-rpc-closure']['headTree']),
         'f-baseline': (ncodec['sides']['c']['base'], F_CHAIN, f931['sides']['f-rpc-closure']['headTree']),
         'b-launch': (N493, P(X('0630'), f630['sides']['d-linux-fec']) + P(X('0745'), f745['sides']['d-linux-carrier']), f745['sides']['d-linux-carrier']['headTree']),
         'e-wallet': (bevm['enclave']['base'], A_CHAIN + P(X('0830'), aw)[:4] + P(X('0931'), f931['sides']['s-browser']), f931['sides']['s-browser']['headTree']),
         'a-gaps': (bevm['enclave']['base'], A_CHAIN + P(X('0830'), aw) + P(X('0931'), f931['sides']['a-parity']), f931['sides']['a-parity']['headTree']),
         'root-ram96b': (None, P(X('1118'), f1118['sides']['root-ram96']), f1118['sides']['root-ram96']['headTree'])}
for k in {**s, **d}:
    BASES.setdefault(k, (None, [], EMPTY))
assert f931['sides']['f-rpc-closure']['head'] == s['s-role']['base'] == s['f-baseline']['base']
assert f745['sides']['d-linux-carrier']['head'] == s['b-launch']['base'] and f931['sides']['s-browser']['head'] == s['e-wallet']['base']
assert f931['sides']['a-parity']['head'] == d['a-gaps']['base'] and f1118['sides']['root-ram96']['head'] == s['root-ram96b']['base']
def check(name, side):
    start, steps, want = BASES[name]
    with tempfile.TemporaryDirectory(prefix='frozen-1339-verify-') as tmp:
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

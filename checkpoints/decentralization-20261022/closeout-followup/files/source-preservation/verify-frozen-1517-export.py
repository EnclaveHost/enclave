"""Prove the frozen-1517 patches reproduce every recorded tree, offline, from PUSHED checkpoint material (4aaba75b), in throwaway
bare repos with a temporary index ("1517" = the batch start 2026-10-23T15:17Z, an identifier). Bases are rebuilt from the stored patch
chains of the earlier exports (frozen-0331..1339); a merge is applied as its stored one diff against the first parent; a commit marked
emptyAfterExclusion must leave the derived tree unchanged. a-receipts, tp-compose and e-prod-report reproduce DERIVATIVE trees only.
Writes source-preservation/frozen-1517-export/REPRODUCE-CHECK.txt."""
from pathlib import Path
import json, os, subprocess, tempfile
root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
checkpoint = root / 'work/source-checkpoint-20261022/main-repo'
CK = '4aaba75beee896bfd4a042d9f848f820d54925c7'
STORED = 'checkpoints/decentralization-20261022/closeout-followup/files/'
out = base / 'source-preservation/frozen-1517-export'
inv = json.loads((out / 'INVENTORY.json').read_text())
EMPTY = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
report = []
def stored(rel): return subprocess.run(['git', '-C', str(checkpoint), 'show', f'{CK}:{STORED}{rel}'], check=True, capture_output=True).stdout
J = lambda rel: json.loads(stored(rel))
X = lambda n: f'source-preservation/frozen-{n}-export/'
f331, f410, f420, f630, f745, f830, f931, f1118, f1339 = (J(X(n) + 'INVENTORY.json') for n in ('0331', '0410', '0420', '0630', '0745', '0830', '0931', '1118', '1339'))
ncodec = J('rpc-native-codec-export/INVENTORY.json'); bevm = J('rpc-base-evm-export/INVENTORY.json')
P = lambda prefix, side: [prefix + p['file'] for p in side['patches']]
F_CHAIN = (P('rpc-native-codec-export/', ncodec['sides']['c']) + P(X('0410'), f410['sides']['c-host-services-cold'])
           + P(X('0630'), f630['sides']['c-carriers']) + P(X('0830'), f830['merge']) + P(X('0931'), f931['sides']['f-rpc-closure']))
A_CHAIN = (P('rpc-base-evm-export/', bevm['enclave']) + P(X('0331'), f331['sides']['a-verifier-authority']) + P(X('0410'), f410['sides']['a-reth-e2e'])
           + P(X('0420'), f420['sides']['a-policy-callers']) + P(X('0630'), f630['sides']['a-native-relay']))
aw = f830['sides']['a-windows']; F0 = ncodec['sides']['c']['base']; A0 = bevm['enclave']['base']
S_CHAIN = P(X('0630'), f630['sides']['s-holder']) + P(X('0745'), f745['sides']['s-holder-final']) + P(X('0830'), f830['sides']['s-root-doc'])
sr = f1339['sides']['s-role']
s, d = inv['sides'], inv['derivatives']
BASES = {'e-prod': (A0, A_CHAIN + P(X('0830'), aw)[:4] + P(X('0931'), f931['sides']['s-browser']) + P(X('1339'), f1339['sides']['e-wallet']), f1339['sides']['e-wallet']['headTree']),
         'f-runtime-gap': (F0, F_CHAIN + P(X('1339'), f1339['sides']['f-baseline']), f1339['sides']['f-baseline']['headTree']),
         'm-cancel': (F0, F_CHAIN + P(X('1339'), sr)[:2], sr['commits'][1]['tree']),
         's-iface': (F0, F_CHAIN + P(X('1339'), sr), sr['headTree']),
         't-compose': (None, P(X('1339'), f1339['sides']['t-hdd']), f1339['sides']['t-hdd']['headTree']),
         'ts-compose': (None, S_CHAIN + P(X('1118'), f1118['sides']['s-compose']), f1118['sides']['s-compose']['headTree']),
         'tp-compose': (None, P(X('0931'), f931['derivatives']['p-l1']) + P(X('1118'), f1118['derivatives']['p-compose']), f1118['derivatives']['p-compose']['headTree']),
         'a-receipts': (A0, A_CHAIN + P(X('0830'), aw) + P(X('0931'), f931['sides']['a-parity']) + P(X('1339'), f1339['derivatives']['a-gaps']), f1339['derivatives']['a-gaps']['headTree'])}
for k in {**s, **d}:
    BASES.setdefault(k, (None, [], EMPTY))
assert sr['commits'][1]['commit'] == s['m-cancel']['base'] and sr['head'] == s['s-iface']['base'] and f1339['sides']['e-wallet']['head'] == s['e-prod']['base']
assert f1339['sides']['f-baseline']['head'] == d['f-runtime-gap']['base'] and f1339['sides']['t-hdd']['head'] == s['t-compose']['base']
assert f1118['sides']['s-compose']['head'] == s['ts-compose']['base'] and f1118['derivatives']['p-compose']['head'] == d['tp-compose']['base']
assert f1339['derivatives']['a-gaps']['head'] == d['a-receipts']['base']
def check(name, side):
    start, steps, want = BASES[name]
    with tempfile.TemporaryDirectory(prefix='frozen-1517-verify-') as tmp:
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

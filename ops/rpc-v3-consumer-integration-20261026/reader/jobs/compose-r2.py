#!/usr/bin/python3 -I
# reader-runtime-composition-stage/r2: deterministic composition of KVM reader v3 (34a3c0d6d) onto the qualified v2 tree 1df12559.
# Reads git objects only (private bare repo, alternates = the enclave object store); never writes source, the v2 stage or KVM's tree.
# Writes COMPOSITION.json, composition.patch (64156dcd -> r2 tree, combined final v3 reader closure) and v2-to-r2.patch (delta from v2).
#   usage: python3 -I reader-runtime-composition-stage/r2/jobs/compose-r2.py
import json, os, pathlib, subprocess
R2 = pathlib.Path(__file__).resolve().parent.parent; V2 = R2.parent; SRC_OBJ = '/home/steven/Projects/enclave/.git/objects'
BASE, C66, V3 = '64156dcd91ff1e769e74f9c26a846be19254c716', 'c66b087acca2bed00e0232f97f990a201852faea', '34a3c0d6d4c5aebffffb2492437487c9de74fb66'
V2_TREE = '1df125598825fb5278fe6af96a50a69b46679a1c'
G = R2 / 'git'
if not G.exists():
    subprocess.run(['git', 'init', '-q', '--bare', str(G)], check=True); (G / 'objects/info/alternates').write_text(SRC_OBJ + '\n')
def g(*a, env=None, raw=False):
    r = subprocess.run(['git', f'--git-dir={G}', *a], capture_output=True, check=True, env=env)
    return r.stdout if raw else r.stdout.decode().strip()
assert g('rev-parse', f'{V3}^') == C66, 'v3 parent is not c66b087'
assert subprocess.run(['git', f'--git-dir={G}', 'merge-base', '--is-ancestor', BASE, V3]).returncode == 0
v2 = json.load(open(V2 / 'COMPOSITION.json')); assert v2['composedTree'] == V2_TREE and len(v2['files']) == 27
roles = {f['path']: f['role'] for f in v2['files']}
delta = [l.split('\t') for l in g('diff', '--name-status', '--no-renames', C66, V3).splitlines()]
for st, p in delta:
    assert st in ('A', 'M') and (p.startswith('network/derived-reader/') or p.startswith('test/derived-reader')), (st, p)
    roles.setdefault(p, 'reader-test' if p.startswith('test/') else 'reader')
# every r2 file must be V3's blob, absent from the base; lifecycle closure files must be unchanged c66 -> v3
files = []
for p in sorted(roles):
    ls = g('ls-tree', V3, '--', p).split(); assert ls and ls[1] == 'blob', p
    assert subprocess.run(['git', f'--git-dir={G}', 'cat-file', '-e', f'{BASE}:{p}'], capture_output=True).returncode != 0, f'{p} in base'
    changed = any(q == p for _, q in delta)
    files.append({'path': p, 'blob': ls[2], 'mode': ls[0], 'origin': '34a3c0d6d' if changed else 'c66b087ac (unchanged in 34a3c0d6d)',
                  'role': roles[p]})
# the new v3 imports outside the reader dir: base blobs must equal v3 blobs (reused, not added)
reused = ['network/lease-release-journal.mjs', 'network/runtime-lock.mjs', 'network/rpc-runtime.mjs', 'network/gossip-head-source.mjs',
          'network/op-head-relay.mjs', 'network/verified-chain.mjs', 'package.json', 'package-lock.json']
for p in reused:
    assert g('rev-parse', f'{BASE}:{p}') == g('rev-parse', f'{V3}:{p}'), f'{p} differs base vs v3'
env = dict(os.environ, GIT_INDEX_FILE=str(G / 'r2.index'))
g('read-tree', BASE, env=env)
for f in files:
    g('update-index', '--add', '--cacheinfo', f"{f['mode']},{f['blob']},{f['path']}", env=env)
tree = g('write-tree', env=env); (G / 'r2.index').unlink()
env = dict(os.environ, GIT_INDEX_FILE=str(G / 'r2b.index'))   # independent route: rebuild v2 (base + its 27 blobs), then the v3 deltas
g('read-tree', BASE, env=env)
for f in v2['files']:
    g('update-index', '--add', '--cacheinfo', f"{f['mode']},{f['blob']},{f['path']}", env=env)
assert g('write-tree', env=env) == V2_TREE, 'v2 tree does not rebuild from its COMPOSITION.json'
for st, p in delta:
    f = next(x for x in files if x['path'] == p); g('update-index', '--add', '--cacheinfo', f"{f['mode']},{f['blob']},{f['path']}", env=env)
assert g('write-tree', env=env) == tree, 'v2+delta != base+files'; (G / 'r2b.index').unlink()
paths = [f['path'] for f in files]
(R2 / 'composition.patch').write_bytes(g('diff', '--binary', '--full-index', BASE, V3, '--', *paths, raw=True))
(R2 / 'v2-to-r2.patch').write_bytes(g('diff', '--binary', '--full-index', V2_TREE, tree, raw=True))
rng = set(g('diff', '--name-only', '--no-renames', BASE, V3).splitlines())
pin = lambda p: g('rev-parse', f'{V3}:{p}')
cfg = json.loads(g('show', f'{V3}:network/derived-reader/config.v3.example.json'))
doc = {
  'format': 'enclave-reader-runtime-composition/v2', 'base': v2['base'], 'readerCommit': V3, 'readerParent': C66,
  'chain': [BASE, '903f107b1', 'cc8c9bd4f', C66, V3], 'v2Stage': {'composedTree': V2_TREE, 'sha256sums': '902786cd2709c1b41716d9cac71b861a016bba06464dfba4dadae26b53da8853'},
  'composedTree': tree, 'files': files,
  'deltaFromV2': [{'status': st, 'path': p, 'v2Blob': next((x['blob'] for x in v2['files'] if x['path'] == p), None),
                   'r2Blob': next(x['blob'] for x in files if x['path'] == p)} for st, p in delta],
  'excludedFromBaseToV3Range': sorted(rng - set(paths)), 'reusedFromBaseUnchanged': reused,
  'pins': {'nativeV3Sha256': cfg['native']['sha256'], 'nativeV3ResultVersion': cfg['native']['resultVersion'],
           'nativeV2Sha256': 'f1a6bb0e82be37fddf9e2485c50f78b4cd5eb02d43e903152230c91fd22dcfd9', 'heliosSha256': cfg['l1']['binary']['sha256'],
           'configV3ExampleBlob': pin('network/derived-reader/config.v3.example.json'), 'qualificationBlob': pin('network/derived-reader/qualification.json'),
           'coverageDocBlob': pin('network/derived-reader/COVERAGE.md')},
  'tests': {'expected': 33, 'provider': 8, 'boundaries': 8, 'coverage': 13, 'bridge': 4,
            'files': ['test/derived-reader.test.mjs', 'test/lifecycle-finality-bridge.test.mjs']},
  'notClaimed': 'integration preparation only: no SNP, no positive Base derivation, no accepted image, no production activation; writer/paid not composed',
}
assert cfg['native']['sha256'] == '49f4d7e3e70e48f7374b0e12b3d300978062cce19cbd75552065f918173a76fa'
(R2 / 'COMPOSITION.json').write_text(json.dumps(doc, indent=1) + '\n')
print('r2 tree', tree, 'files', len(files), 'delta', len(delta), 'excluded', len(doc['excludedFromBaseToV3Range']))

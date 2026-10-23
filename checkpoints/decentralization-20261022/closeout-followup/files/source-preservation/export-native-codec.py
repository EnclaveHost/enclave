"""Export FINISHED worker commits for the checkpoint, from Git OBJECTS only (never from mutable or dirty worktrees).

* B listener  rpc-gossip-bridge/listener  f3159ea (already preserved) .. 5e17867  (native `commitment` mode; code a0c7c4e)
* B bridge    rpc-gossip-bridge           root .. d2f9e0c                          (gossip-head-source, no JS codec)
* C           windows-host-services-compose/candidate  public f58e03ec4 .. d7f520bf (the last patch is exactly
              d281007c..d7f520bf; d281007c = parent of the accepted composition a6fb7aab, both unpushed, so the series
              starts at the nearest pushed ancestor)
* D           linux-wallet-unknown/candidate  public 2bbea898 .. 09ff3ed5            (3 files)

Per side: format-patch series (--full-index --no-renames) and every changed file at its head blob. Non-Git reports are
hashed into INVENTORY.json (capture-latest.py refuses to copy anything that changed after this export). Writes only
rpc-native-codec-export/ (rebuilt from scratch except REBUILD.md). No network, builds or tests.
"""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess

root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
out = base / 'rpc-native-codec-export'
checkpoint = root / 'work/source-checkpoint-20261022/main-repo'
AUTHOR = 'SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'
EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

SIDES = {
    'listener': {'repo': base / 'rpc-gossip-bridge/listener', 'name': 'b-listener-commitment-mode-5e17867',
                 'branch': 'commitment-mode', 'base': 'f3159ea73786eeda344f2ffa1dc82d59de46a6db',
                 'head': '5e178676bbe0ce5cda7ea95a3ccfefa8dca8a4b7',
                 'commits': ['389d527', 'a0c7c4e', '5e17867'],
                 'baseProvenance': 'f3159ea = worker B head-listener, already preserved in the checkpoint as tracked files + '
                                   'source-preservation/head-listener-f3159ea-inventory.json (tree 298e1ef5); the frozen original '
                                   'repo rpc-peer-audit/head-listener is untouched'},
    'bridge': {'repo': base / 'rpc-gossip-bridge', 'name': 'b-gossip-bridge-d2f9e0c', 'branch': 'main', 'base': None,
               'head': 'd2f9e0c10d20676619ba9466899dc58a36c9aa75',
               'commits': ['edf722f', '9d2a597', 'cd38d79', 'd0c5c14', 'f6a9458', 'df8c1e4', '5ec1be4', '57e4fd8', 'd767f80',
                           '4505f27', 'd2f9e0c'],
               'baseProvenance': 'root commit edf722f (new repository); network/op-head-relay.mjs and network/rpc-identity.mjs '
                                 'are byte-identical reference copies of worker A 97785a40c (already preserved via A)'},
    'c': {'repo': base / 'windows-host-services-compose/candidate', 'name': 'c-host-services-compose-d7f520bf',
          'branch': 'compose/host-services', 'base': 'f58e03ec4', 'head': 'd7f520bf8eca94ce3464bc0b70a0619261c04b68',
          'commits': ['8ba643433', 'f666306d8', '49afbb608', '81fb54897', '993d92ec0', 'd281007c2', 'd7f520bf8'],
          'baseProvenance': 'f58e03ec4 is on the pushed checkpoint branch. d281007c (C\'s stated base) = parent of the accepted '
                            'Windows composition a6fb7aab; neither is pushed, so patches 0001-0006 rebuild d281007c from '
                            'f58e03ec4 and patch 0007 is exactly d281007c..d7f520bf'},
    'd': {'repo': base / 'linux-wallet-unknown/candidate', 'name': 'd-linux-wallet-unknown-09ff3ed5',
          'branch': 'fix/linux-wallet-unknown-hold', 'base': '2bbea8987ddc3d127c15e9709b5db2f867eae30d',
          'head': '09ff3ed553ba97f5fd5a880ab4197d3209a83d0a', 'commits': ['09ff3ed55'],
          'baseProvenance': '2bbea898 = an earlier pushed commit of this checkpoint branch'},
}
# Non-Git reports frozen by hash (stability is re-checked at capture).
FROZEN = ['windows-host-services-compose/RESULT.md', 'windows-host-services-compose/PROVENANCE.files.json',
          'linux-wallet-unknown/RESULT.md', 'rpc-gossip-bridge/listener/upstream/PROVENANCE.json']


def git(repo, *args, text=True):
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=text).stdout


def sha(data):
    return hashlib.sha256(data).hexdigest()


def export(key, spec):
    repo, dst = spec['repo'], out / spec['name']
    head = git(repo, 'rev-parse', spec['head'] + '^{commit}').strip()
    assert head == spec['head'], f'{key}: {spec["head"]} resolves to {head}'
    rng = f"{spec['base']}..{head}" if spec['base'] else head
    log = git(repo, 'log', '--reverse', '--format=%H%x09%P%x09%T%x09%an <%ae>%x09%cn <%ce>%x09%cI%x09%s', rng).splitlines()
    rows = [dict(zip(('commit', 'parent', 'tree', 'author', 'committer', 'committedAt', 'subject'), l.split('\t'))) for l in log]
    assert [r['commit'][:len(c)] for r, c in zip(rows, spec['commits'])] == spec['commits'] and len(rows) == len(spec['commits']), \
        f"{key}: commits {[r['commit'][:9] for r in rows]} != {spec['commits']}"
    base_full = git(repo, 'rev-parse', spec['base'] + '^{commit}').strip() if spec['base'] else None
    assert rows[0]['parent'] == (base_full or ''), f'{key}: first parent'
    assert all(rows[i]['parent'] == rows[i - 1]['commit'] for i in range(1, len(rows))), f'{key}: not a linear series'
    assert all(r['author'] == AUTHOR and r['committer'] == AUTHOR for r in rows), f'{key}: unexpected author/committer'
    names = git(repo, 'diff', '--name-status', '--no-renames', base_full or EMPTY_TREE, head).splitlines()
    files = []
    for line in names:
        status, path = line.split('\t')
        if status == 'D':
            files.append({'path': path, 'status': 'D', 'baseBlob': git(repo, 'rev-parse', f'{base_full}:{path}').strip()})
            continue
        assert status in ('A', 'M'), line
        blob = git(repo, 'rev-parse', f'{head}:{path}').strip()
        data = git(repo, 'cat-file', 'blob', blob, text=False)
        data.decode('utf-8')   # every authored file is text (hex fixtures, sources, logs); a binary aborts the export
        mode = git(repo, 'ls-tree', head, '--', path).split()[0]
        target = dst / 'files' / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        files.append({'path': path, 'status': status, 'mode': mode, 'blob': blob, 'sha256': sha(data), 'bytes': len(data),
                      'baseBlob': git(repo, 'rev-parse', f'{base_full}:{path}').strip() if status == 'M' else None})
    (dst / 'patches').mkdir(parents=True)
    git(repo, 'format-patch', '--full-index', '--no-renames', '--no-signature', '-o', str(dst / 'patches'),
        *(['--root', head] if not spec['base'] else [rng]))
    patches = sorted((dst / 'patches').iterdir())
    assert len(patches) == len(rows), f'{key}: {len(patches)} patches for {len(rows)} commits'
    for p in patches:
        p.read_bytes().decode('utf-8')
    return {'repo': str(repo.relative_to(base)), 'branch': spec['branch'],
            'branchHeadAtExport': git(repo, 'rev-parse', spec['branch']).strip(),
            'base': base_full, 'baseProvenance': spec['baseProvenance'], 'head': head, 'headTree': rows[-1]['tree'],
            'commits': rows, 'changedFiles': files,
            'patches': [{'file': str(p.relative_to(out)), 'sha256': sha(p.read_bytes())} for p in patches]}


out.mkdir(exist_ok=True)
for child in out.iterdir():
    if child.name != 'REBUILD.md':
        shutil.rmtree(child) if child.is_dir() else child.unlink()

sides = {k: export(k, s) for k, s in SIDES.items()}
# Bases that must be public (on the pushed checkpoint branch) for the series to be reconstructible.
for key in ('c', 'd'):
    b = sides[key]['base']
    subprocess.run(['git', '-C', str(checkpoint), 'merge-base', '--is-ancestor', b, 'HEAD'], check=True)
# f3159ea itself is preserved as files: the inventory in the checkpoint must name it.
inv = json.loads((checkpoint / 'checkpoints/decentralization-20261022/closeout-followup/files/source-preservation/'
                  'head-listener-f3159ea-inventory.json').read_text())
assert inv['commit'] == SIDES['listener']['base'] and inv['tree'] == git(SIDES['listener']['repo'], 'rev-parse', 'f3159ea^{tree}').strip()

frozen = {name: sha((base / name).read_bytes()) for name in FROZEN}
ldir = base / 'rpc-gossip-bridge/listener'
inventory = {
    'format': 'enclave-native-codec-export/v1',
    'label': ('SOURCE + OFFLINE PROOF ONLY. Not deployed, not merged into the normal tree. B: native `commitment` mode (maintained '
              'base/base verify first, then the exact signed commitment bytes from the maintained snap decoder, bounded before '
              'allocation) and the gossip-head-source bridge consuming it (A\'s relay verifyCommitment recovers the signer '
              'independently); native 7/7, bridge 28/28 offline. No fresh RPC independence, finality, state availability or '
              'Denim-rate proof. C: host-services composition d7f520bf, hostServices zero-app gate and generated-package CLI '
              'guard OUTSTANDING, not production-ready. D: Linux unknown-wallet hold 09ff3ed5, epoch/failed-stop review '
              'PENDING (ROOT-LINUX-HOLD-REVIEW.txt), no image or deployment.'),
    'sides': sides,
    'frozenSources': frozen,
    'listenerBuild': {'binarySha256': 'ebd045b428227530fac1c1b079f47c67ecb874637a1c7dcb4f021dd5929e8d3a', 'builtFrom': 'a0c7c4e',
                      'rust': '1.96.0', 'upstreamTarball': 'https://codeload.github.com/base/base/tar.gz/'
                      '5476069f1eb74a56bccb56fdefd4b4bb0e3cda42 sha256 9784e20a3cfeac555d96e8d1f15526d5264f0e6d8885b951c6f1220355038012',
                      'cargoLockSha256': sha((ldir / 'Cargo.lock').read_bytes())},
    'notPreserved': ['worktrees (C has an untracked generated network/host-services/packages/; C and D are ACTIVE and their '
                     'newer working changes are deliberately not read)', 'target/ and artifacts/ binaries (listener ebd045b4)',
                     'node_modules (bridge symlink to A\'s tree)', 'listener upstream/ vendored crate copies (regenerated by '
                     'tools/prepare-upstream.py from the pinned tarball)', 'C/D logs/, tmp/, stubs/ and job scripts outside Git',
                     'raw cargo caches'],
}
(out / 'INVENTORY.json').write_text(json.dumps(inventory, indent=1) + '\n')
print(json.dumps({k: {'commits': len(v['commits']), 'files': len(v['changedFiles']), 'patches': len(v['patches'])}
                  for k, v in sides.items()} | {'frozen': len(frozen), 'inventorySha256': sha((out / 'INVENTORY.json').read_bytes())}))

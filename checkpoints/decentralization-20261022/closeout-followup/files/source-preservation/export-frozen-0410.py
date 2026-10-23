"""Export the 04:10Z frozen commits for the checkpoint, from Git OBJECTS only (never from mutable or dirty worktrees).

* a-reth-e2e            rpc-priority/repo                    921d60c2 .. 0c43e4db   (canonical-trie Reth consumer E2E)
* b-verifier-deadline   rpc-verifier-deadline/repo           921d60c2 .. 62feb3aa .. 8d110101   (whole-op deadline + ref'd timer)
* c-host-services-cold  windows-host-services-compose/cand.  d7f520bf .. 427780bb   (cold start; NOT rollout-ready)
* d-linux-hold-final    linux-wallet-unknown/candidate       b744ba19 .. f1d0666b   (decision-window + teardown paths)
* e-sia-cache-compose   rpc-sia-cache/compose/repo           bfbd649d .. 73c11ec9 .. 27785278   (S3 ARCHIVE tier)
* p-real-history        witness-failover/repo                ce7c1b73 .. 7b4dd692   (bounded real-proof recording)

Every base is a head already preserved in checkpoint f6668d86 (rebuilt by verify-frozen-0410-export.py). Per side: a
format-patch series (--full-index --no-renames) and every changed file at its head blob. No binaries in any series.
Worker reports and root evidence are only hashed here; capture-frozen-0410.py refuses to copy anything whose bytes changed
after this export. Writes only source-preservation/frozen-0410-export/ (rebuilt from scratch except REBUILD.md). No
network, builds or tests.
"""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess

root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
out = base / 'source-preservation/frozen-0410-export'
checkpoint = root / 'work/source-checkpoint-20261022/main-repo'
CHECKPOINT_HEAD = 'f6668d86584f67a5dee5b9a5261d9a725a4de754'
AUTHOR = 'SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'
A921 = '921d60c2b37ec8ae64e1fd22d7bc7b408939bd70'

SIDES = {
    'a-reth-e2e': {
        'repo': base / 'rpc-priority/repo', 'name': 'a-reth-e2e-0c43e4db', 'branch': 'rpc-priority',
        'base': A921, 'head': '0c43e4db89f1be615ff11319abc43aefd69a9fcb', 'commits': ['0c43e4db8'],
        'baseProvenance': '921d60c2 preserved in f6668d86 as frozen-0331-export/a-verifier-authority-921d60c2 (1 patch on 9fdc1418c)'},
    'b-verifier-deadline': {
        'repo': base / 'rpc-verifier-deadline/repo', 'name': 'b-verifier-deadline-8d110101', 'branch': 'verifier-deadline',
        'base': A921, 'head': '8d110101f6cdd5a03ffa16f52e6afb1ea8c6f346', 'commits': ['62feb3aaf', '8d110101f'],
        'baseProvenance': '921d60c2 as for a-reth-e2e'},
    'c-host-services-cold': {
        'repo': base / 'windows-host-services-compose/candidate', 'name': 'c-host-services-cold-427780bb', 'branch': 'compose/host-services',
        'base': 'd7f520bf8eca94ce3464bc0b70a0619261c04b68', 'head': '427780bbc0fc524f8091893614eae8a653518139', 'commits': ['427780bbc'],
        'baseProvenance': 'd7f520bf preserved in f6668d86 as rpc-native-codec-export/c-host-services-compose-d7f520bf (7 patches on '
                          'f58e03ec4, a commit of this checkpoint branch; d281007c = patches 0001-0006)'},
    'd-linux-hold-final': {
        'repo': base / 'linux-wallet-unknown/candidate', 'name': 'd-linux-hold-final-f1d0666b', 'branch': 'fix/linux-wallet-unknown-hold',
        'base': 'b744ba19022763e9688c6b006e8cecd24e21cc18', 'head': 'f1d0666b9fc80d25a7c4cbacf4025f3a33152111', 'commits': ['f1d0666b9'],
        'baseProvenance': 'b744ba19 preserved in f6668d86 as frozen-0318-export/d-linux-wallet-review-b744ba19 on 09ff3ed5 '
                          '(rpc-native-codec-export/d-linux-wallet-unknown-09ff3ed5, 1 patch on checkpoint commit 2bbea898)'},
    'e-sia-cache-compose': {
        'repo': base / 'rpc-sia-cache/compose/repo', 'name': 'e-sia-cache-compose-27785278', 'branch': 'work/sia-cache-compose',
        'base': 'bfbd649d8c416922691a6dd1eaada8a81765bba5', 'head': '2778527853fdf2a42675eb8e613646727b7df509',
        'commits': ['73c11ec93', '277852785'],
        'baseProvenance': 'bfbd649d preserved in f6668d86 as frozen-0318-export/witness-enclave-bfbd649d (2 patches on 9fdc1418c); '
                          '73c11ec9 is the S3 backend (same feature as the archived b71c8261, rebased onto bfbd649d)'},
    'p-real-history': {
        'repo': base / 'witness-failover/repo', 'name': 'p-real-history-7b4dd692', 'branch': 'witness-failover',
        'base': 'ce7c1b7309dbc1cb65bedbdf7db5a173c977208c', 'head': '7b4dd69201d00bc5649cda6bcf57b21c6197c3af', 'commits': ['7b4dd6920'],
        'baseProvenance': 'ce7c1b73 preserved in f6668d86 as frozen-0331-export/p-history-enclave-ce7c1b73 (2 patches on bfbd649d)'},
}
FROZEN = ['rpc-verifier-deadline/RESULT.md',
          'windows-host-services-compose/RESULT-COLD.md', 'windows-host-services-compose/PROVENANCE-COLD.json',
          'linux-wallet-unknown/RESULT-DECISION-WINDOW.md', 'linux-wallet-unknown/TEST-EVIDENCE-LINUX-HOLD.txt',
          'linux-wallet-unknown/linux-wallet-unknown.patch', 'linux-wallet-unknown/linux-wallet-unknown-review.patch',
          'linux-wallet-unknown/linux-wallet-unknown-decision-window.patch', 'linux-wallet-unknown/linux-wallet-unknown-full.patch',
          'rpc-sia-cache/compose/RESULT-COMPOSE.md',
          'witness-failover/RESULT-REAL-HISTORY.md', 'witness-failover/PROVENANCE-REAL-HISTORY.json',
          'witness-failover/TEST-EVIDENCE-REAL-HISTORY.txt']
# already-captured D reports: must be unchanged (verified, not recaptured)
UNCHANGED = {'linux-wallet-unknown/RESULT.md': 'd301ff6b', 'linux-wallet-unknown/RESULT-REVIEW.md': 'b1f833e8'}
ROOT_EVIDENCE = ['root-host-service-stop-race.mjs', 'root-host-service-stop-race-result.json',
                 'check-dns-tls-0408.py', 'check-dns-cert-log-0408.py',
                 '../../outputs/decentralization-audit/enclavedns-tls-followup-20261023T0408Z.json',
                 '../../outputs/decentralization-audit/enclavedns-cert-log-20261023T0408Z.json']


def git(repo, *args, text=True):
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=text).stdout


def sha(data):
    return hashlib.sha256(data).hexdigest()


def export(key, spec):
    repo, dst = spec['repo'], out / spec['name']
    head = git(repo, 'rev-parse', spec['head'] + '^{commit}').strip()
    assert head == spec['head'], f'{key}: {spec["head"]} resolves to {head}'
    base_full = git(repo, 'rev-parse', spec['base'] + '^{commit}').strip() if spec['base'] else None
    assert base_full == spec['base'], key
    rng = f'{base_full}..{head}' if base_full else head
    log = git(repo, 'log', '--reverse', '--format=%H%x09%P%x09%T%x09%an <%ae>%x09%cn <%ce>%x09%cI%x09%s', rng).splitlines()
    rows = [dict(zip(('commit', 'parent', 'tree', 'author', 'committer', 'committedAt', 'subject'), l.split('\t'))) for l in log]
    assert len(rows) == len(spec['commits']) and [r['commit'][:len(c)] for r, c in zip(rows, spec['commits'])] == spec['commits'], \
        f"{key}: commits {[r['commit'][:9] for r in rows]} != {spec['commits']}"
    assert rows[0]['parent'] == (base_full or ''), f'{key}: first parent'
    assert all(rows[i]['parent'] == rows[i - 1]['commit'] for i in range(1, len(rows))), f'{key}: not a linear series'
    assert all(r['author'] == AUTHOR and r['committer'] == AUTHOR for r in rows), f'{key}: unexpected author/committer'
    binaries = spec.get('binaryAsHex', [])
    files = []
    diff_args = [base_full, head] if base_full else ['4b825dc642cb6eb9a060e54bf8d69288fbee4904', head]
    for line in git(repo, 'diff', '--name-status', '--no-renames', *diff_args).splitlines():
        status, path = line.split('\t')
        if status == 'D':
            files.append({'path': path, 'status': 'D', 'baseBlob': git(repo, 'rev-parse', f'{base_full}:{path}').strip()})
            continue
        assert status in ('A', 'M'), line
        blob = git(repo, 'rev-parse', f'{head}:{path}').strip()
        data = git(repo, 'cat-file', 'blob', blob, text=False)
        mode = git(repo, 'ls-tree', head, '--', path).split()[0]
        assert mode in ('100644', '100755'), (path, mode)
        entry = {'path': path, 'status': status, 'mode': mode, 'blob': blob, 'sha256': sha(data), 'bytes': len(data),
                 'baseBlob': git(repo, 'rev-parse', f'{base_full}:{path}').strip() if status == 'M' else None}
        if path in binaries:
            assert status == 'A' and len(rows) == 1, (key, path)   # verifier re-adds it before the single commit's tree
            stored = dst / 'files' / (path + '.hex')
            stored.parent.mkdir(parents=True, exist_ok=True)
            stored.write_text(data.hex() + '\n')
            entry.update(storedAsHex=path + '.hex', hexSha256=sha(stored.read_bytes()))
        else:
            data.decode('utf-8')   # every other authored file is text; an unlisted binary aborts the export
            target = dst / 'files' / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        files.append(entry)
    assert sorted(f['path'] for f in files if 'storedAsHex' in f) == sorted(binaries), (key, binaries)
    (dst / 'patches').mkdir(parents=True)
    git(repo, 'format-patch', '--full-index', '--no-renames', '--no-signature', '-o', str(dst / 'patches'),
        *(['--root', head] if not base_full else [rng]), '--', '.', *[f':(exclude){b}' for b in binaries])
    patches = sorted((dst / 'patches').iterdir())
    assert len(patches) == len(rows), f'{key}: {len(patches)} patches for {len(rows)} commits'
    for p in patches:
        p.read_bytes().decode('utf-8')
        assert b'GIT binary patch' not in p.read_bytes(), p
    result = {'repo': str(repo.relative_to(root)), 'branch': spec['branch'],
              'headReachableFromBranch': subprocess.run(['git', '-C', str(repo), 'merge-base', '--is-ancestor', head,
                                                         spec['branch']]).returncode == 0,
              'base': base_full, 'baseProvenance': spec['baseProvenance'], 'head': head, 'headTree': rows[-1]['tree'],
              'commits': rows, 'changedFiles': files,
              'patches': [{'file': str(p.relative_to(out)), 'sha256': sha(p.read_bytes())} for p in patches]}
    if spec.get('rootBase'):
        result['baseTreeFiles'] = [dict(zip(('mode', 'type', 'blob'), l.split('\t')[0].split()), path=l.split('\t')[1])
                                   for l in git(repo, 'ls-tree', '-r', base_full).splitlines()]
        result['baseTree'] = git(repo, 'rev-parse', base_full + '^{tree}').strip()
    return result


assert git(checkpoint, 'rev-parse', 'HEAD').strip() == CHECKPOINT_HEAD, 'checkpoint HEAD moved'
out.mkdir(exist_ok=True)
for child in out.iterdir():
    if child.name != 'REBUILD.md':
        shutil.rmtree(child) if child.is_dir() else child.unlink()

sides = {k: export(k, s) for k, s in SIDES.items()}
files = {k: {f['path']: f.get('sha256') for f in v['changedFiles']} for k, v in sides.items()}
# C: the exact transport source root's stop-race probe ran on; D: the final supervisor, egress.js unchanged since b744ba19
C_TRANSPORT = sha(git(SIDES['c-host-services-cold']['repo'], 'show', SIDES['c-host-services-cold']['head'] + ':network/host-service-transport.mjs', text=False))
assert C_TRANSPORT == 'de5bb98a2e77ffd90ccf65211f564d9515f667b4cd6d17cbb3644fb2ca454e06'   # unchanged since d7f520bf; read from the 427780bb tree
assert files['d-linux-hold-final']['supervisor.js'] == 'e50da21dac2cbbd79d06dc971558c17a8352bb590811b7366a08f2597579e04d'
assert 'egress.js' not in files['d-linux-hold-final']
frozen = {name: sha((base / name).read_bytes()) for name in FROZEN}
for name, want in UNCHANGED.items():
    assert sha((base / name).read_bytes()).startswith(want), f'{name} changed since it was captured'
evidence = {name: sha((base / name).read_bytes()) for name in ROOT_EVIDENCE}
race = json.loads((base / 'root-host-service-stop-race-result.json').read_text())
assert race['sourceSha256'] == C_TRANSPORT, 'root probe ran on another source'
# every base is a head already preserved at f6668d86 (verify-frozen-0410-export.py rebuilds each)
ck_files = 'checkpoints/decentralization-20261022/closeout-followup/files/'
def stored_inv(rel):
    return json.loads(git(checkpoint, 'show', f'{CHECKPOINT_HEAD}:{ck_files}{rel}'))
f331 = stored_inv('source-preservation/frozen-0331-export/INVENTORY.json')
f318 = stored_inv('source-preservation/frozen-0318-export/INVENTORY.json')
ncodec = stored_inv('rpc-native-codec-export/INVENTORY.json')
assert f331['sides']['a-verifier-authority']['head'] == A921
assert ncodec['sides']['c']['head'] == SIDES['c-host-services-cold']['base']
assert f318['sides']['d-review']['head'] == SIDES['d-linux-hold-final']['base']
assert f318['sides']['witness-enclave']['head'] == SIDES['e-sia-cache-compose']['base']
assert f331['sides']['p-history-enclave']['head'] == SIDES['p-real-history']['base']
inventory = {
    'format': 'enclave-frozen-0410-export/v1',
    'checkpointHeadAtExport': CHECKPOINT_HEAD,
    'label': ('SOURCE + OFFLINE TESTS ONLY. Nothing here is merged into the normal tree, imaged or deployed. a-reth-e2e 0c43e4db: '
              'canonical-trie Reth consumer E2E for the verifier authority (test addition on 921d60c2). b-verifier-deadline '
              '62feb3aa/8d110101: whole verified-operation deadline + closure and a referenced timer (on 921d60c2). '
              'c-host-services-cold 427780bb: zero-app privacy agent behind the platform host policy (on d7f520bf); KNOWN '
              'late-start/close race (root probe: a transport closed before its start returns still creates a circuit + timer) '
              'and a DigitalOcean-mirror-only policy gate: NOT rollout-ready. d-linux-hold-final f1d0666b: decision-time lease '
              'permits and confirmed-stop teardown on every path; needs a measured image AND the decision() admission bundle; '
              'not deployed. e-sia-cache-compose 73c11ec9/27785278: S3 witness store as the gateway ARCHIVE tier; not live Sia. '
              'p-real-history 7b4dd692: bounded real-proof recording; real proof recording FAILED from 2 sources (2 pass, 1 skip): '
              'NOT a successful real-history proof.'),
    'sides': sides,
    'frozenSources': frozen,
    'alreadyCapturedUnchanged': UNCHANGED,
    'rootEvidence': evidence,
    'notPreserved': ['worktrees and anything after the exported heads: A 437d6ced6/2efc4a83e and its untracked trees; B, C, P, E '
                     'active work (E history-compose tree, P new block-response work, C carriers/late-start fix)',
                     'outputs/decentralization-audit/storage-whole-recovery-bounded-live-20261023.json (MUTABLE: root has not frozen it)',
                     'root-host-service-stop-race.guard.log and every raw log, run handle, key, snapshot, archive, compiled binary, '
                     'node_modules, cargo/forge cache and build output',
                     'linux-wallet-unknown candidate node_modules, tmp/ (base copies, mutants, controls) and logs/ (digested into '
                     'TEST-EVIDENCE-LINUX-HOLD.txt)'],
}
(out / 'INVENTORY.json').write_text(json.dumps(inventory, indent=1) + '\n')
print(json.dumps({k: {'commits': len(v['commits']), 'files': len(v['changedFiles']), 'patches': len(v['patches'])}
                  for k, v in sides.items()} | {'frozen': len(frozen), 'rootEvidence': len(evidence),
                                                'inventorySha256': sha((out / 'INVENTORY.json').read_bytes())}))

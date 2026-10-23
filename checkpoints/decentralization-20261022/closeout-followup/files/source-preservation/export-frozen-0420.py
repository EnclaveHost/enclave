"""Export the 04:20Z frozen commits for the checkpoint, from Git OBJECTS only (never from mutable or dirty worktrees).

* a-policy-callers   rpc-priority/repo         0c43e4db .. 437d6ced .. 2efc4a83   (policy readers + callers choose the local verifier)
* d-root-adopt-stop  linux-adopt-stop-review   f1d0666b .. 1086cf23               (ROOT's adopt() pending-stop/withdrawal guard)

Both bases are heads already preserved in checkpoint 34723cba (frozen-0410-export; rebuilt by verify-frozen-0420-export.py).
Per side: a format-patch series and every changed file at its head blob. No binaries. Reports and root evidence are only
hashed here; capture-frozen-0420.py refuses to copy anything whose bytes changed after this export.
"""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess

root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
out = base / 'source-preservation/frozen-0420-export'
checkpoint = root / 'work/source-checkpoint-20261022/main-repo'
CHECKPOINT_HEAD = '34723cba51f4fbcaff3963b979b7fc45f05e8ee3'
AUTHOR = 'SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'

SIDES = {
    'a-policy-callers': {
        'repo': base / 'rpc-priority/repo', 'name': 'a-policy-callers-2efc4a83', 'branch': 'rpc-priority',
        'base': '0c43e4db89f1be615ff11319abc43aefd69a9fcb', 'head': '2efc4a83ec6636f875fa4523d50674bda06bcdcb',
        'commits': ['437d6ced6', '2efc4a83e'],
        'baseProvenance': '0c43e4db preserved in 34723cba as frozen-0420-export/a-reth-e2e-0c43e4db (1 patch on 921d60c2)'},
    'd-root-adopt-stop': {
        'repo': base / 'linux-adopt-stop-review', 'name': 'd-root-adopt-stop-1086cf23', 'branch': 'fix/adopt-pending-stop',
        'base': 'f1d0666b9fc80d25a7c4cbacf4025f3a33152111', 'head': '1086cf2346b913177e38cf02e0b2b571628cc758', 'commits': ['1086cf234'],
        'baseProvenance': 'f1d0666b preserved in 34723cba as frozen-0420-export/d-linux-hold-final-f1d0666b (1 patch on b744ba19)'},
}
FROZEN = ['rpc-priority/RESULT-CONSUMER-CLOSURE.md']
UNCHANGED = {}
ROOT_EVIDENCE = ['root-linux-adopt-stop-race.mjs', 'root-linux-adopt-stop-race-result.json',
                 'node-updater-readonly/check-0413.py',
                 '../../outputs/decentralization-audit/windows-node-updater-0413-postcheck-20261023.json']


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
# root's fix: the exact supervisor root stated; its probe ran on the f1d0666b supervisor the fix corrects
assert files['d-root-adopt-stop']['supervisor.js'] == '7389d61399d0e94a0f226c8604bd90635db30723c41a7d8aa2c62aaa9dbefbe2'
assert 'ROOT-REVIEW.md' in files['d-root-adopt-stop'] and 'test/adopt-pending-stop.test.mjs' in files['d-root-adopt-stop']
frozen = {name: sha((base / name).read_bytes()) for name in FROZEN}
evidence = {name: sha((base / name).read_bytes()) for name in ROOT_EVIDENCE}
race = json.loads((base / 'root-linux-adopt-stop-race-result.json').read_text())
assert race['sourceSha256'] == 'e50da21dac2cbbd79d06dc971558c17a8352bb590811b7366a08f2597579e04d', 'root adopt probe ran on another source'
ck_files = 'checkpoints/decentralization-20261022/closeout-followup/files/'
f410 = json.loads(git(checkpoint, 'show', f'{CHECKPOINT_HEAD}:{ck_files}source-preservation/frozen-0410-export/INVENTORY.json'))
assert f410['sides']['a-reth-e2e']['head'] == SIDES['a-policy-callers']['base']
assert f410['sides']['d-linux-hold-final']['head'] == SIDES['d-root-adopt-stop']['base']
inventory = {
    'format': 'enclave-frozen-0420-export/v1',
    'checkpointHeadAtExport': CHECKPOINT_HEAD,
    'label': ('SOURCE + OFFLINE TESTS ONLY. Nothing here is merged into the normal tree, imaged or deployed. a-policy-callers '
              '437d6ced/2efc4a83 (on 0c43e4db): service-index and platform host policy read through the local verifier when '
              'chosen, and independent CLI/MCP, management and native callers can choose it; 7 canonical-Reth policy E2Es pass, '
              '130/135 with 5 baseline failures; the existing default authority is preserved. d-root-adopt-stop 1086cf23 (ROOT, '
              'on D f1d0666b): adopt() snapshots record identity/epoch/withdrawal before its await and checks the pending-stop '
              'hold before and after, preserving a fresh adoption; REQUIRED before D can be called rollout-ready. ROOT fix, '
              'source only, NOT activated.'),
    'sides': sides,
    'frozenSources': frozen,
    'alreadyCapturedUnchanged': UNCHANGED,
    'rootEvidence': evidence,
    'notPreserved': ['A worktree and anything after 2efc4a83 (A\'s new relay/native closure, mutable)',
                     'root-linux-adopt-stop-race.guard.log, the review tree\'s node_modules symlink and every raw log, run handle, '
                     'key, mutable live Sia receipt, binary, dependency and build cache'],
}
(out / 'INVENTORY.json').write_text(json.dumps(inventory, indent=1) + '\n')
print(json.dumps({k: {'commits': len(v['commits']), 'files': len(v['changedFiles']), 'patches': len(v['patches'])}
                  for k, v in sides.items()} | {'frozen': len(frozen), 'rootEvidence': len(evidence),
                                                'inventorySha256': sha((out / 'INVENTORY.json').read_bytes())}))

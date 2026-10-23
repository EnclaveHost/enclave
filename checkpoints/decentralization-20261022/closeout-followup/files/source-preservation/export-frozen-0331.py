"""Export the 03:31Z frozen commits for the checkpoint, from Git OBJECTS only (never from mutable or dirty worktrees).

* s-bridge             storage-restore-memory/candidate  0d7e6b8 (root: frozen harness imported unchanged) .. f98786e
* e-sia-cache          rpc-sia-cache/repo                9fdc1418c .. b71c8261   (optional S3 witness cache; not live Sia)
* e-receipt-witness    rpc-receipt-witness               root commit b84c5a11    (diagnostic only; one binary as hex)
* p-history-enclave    witness-failover/repo             bfbd649d .. ce7c1b73    (authenticated ancestry recovery)
* p-history-helios     witness-failover/helios           1ec2c1a5 .. aca81764    (witness-check header ops)
* a-verifier-authority rpc-priority/repo                 9fdc1418c .. 921d60c2   (deadline gap open; B fixing)

Per side: format-patch series (--full-index --no-renames) and every changed file at its head blob. A binary blob is
allowed only where listed (binaryAsHex): it is stored as lowercase hex text and excluded from the patch by pathspec;
the verifier re-adds it. Worker reports and root evidence are only hashed here; capture-frozen-0331.py refuses to copy
anything whose bytes changed after this export. Writes only source-preservation/frozen-0331-export/ (rebuilt from
scratch except REBUILD.md). No network, builds or tests.
"""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess

root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
out = base / 'source-preservation/frozen-0331-export'
checkpoint = root / 'work/source-checkpoint-20261022/main-repo'
CHECKPOINT_HEAD = '552fb9f5460b996c30a69c2600c60c5e38b7d83f'
AUTHOR = 'SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'
NINE = '9fdc1418caff88d1baa5c5967ac7eaaf9cf2a368'

SIDES = {
    's-bridge': {
        'repo': root / 'work/storage-restore-memory/candidate', 'name': 's-bridge-f98786e9', 'branch': 'master',
        'base': '0d7e6b8a6cad4f820c9322323b8fcf7f0cf9bf4e', 'head': 'f98786e90e83c66da6f593315faea83e717caeed',
        'commits': ['f98786e9'], 'rootBase': True,
        'baseProvenance': '0d7e6b8 = root commit importing the frozen sia-whole-restore-harness UNCHANGED (runner d11f7bca, '
                          'whole_restore 8a6cc0d3); all 12 blobs equal the files already stored in this checkpoint under '
                          'sia-whole-restore-harness/, from which its tree is rebuilt'},
    'e-sia-cache': {
        'repo': base / 'rpc-sia-cache/repo', 'name': 'e-sia-cache-b71c8261', 'branch': 'work/sia-witness-cache',
        'base': NINE, 'head': 'b71c82615975ba6d1d7c966d1baddf57f5c53eea', 'commits': ['b71c82615'],
        'baseProvenance': '9fdc1418c = A\'s finished candidate, preserved in 9f40daae as rpc-base-evm-export (4 patches on '
                          'public dfe020abf)'},
    'e-receipt-witness': {
        'repo': base / 'rpc-receipt-witness', 'name': 'e-receipt-witness-b84c5a11', 'branch': 'HEAD',
        'base': None, 'head': 'b84c5a1127edfedf3d6ba8fb1553e17aa50ee846', 'commits': ['b84c5a112'],
        'binaryAsHex': ['probe/fixture-1.json.gz'],
        'baseProvenance': 'root commit (new repository). 4 of its 27 files (RESULT.md, ALLOWLIST.txt/.sha256, '
                          'inventory/consumer-reads.json) were already stored as the 2bbea898-era snapshot rpc-receipt-witness/'},
    'p-history-enclave': {
        'repo': base / 'witness-failover/repo', 'name': 'p-history-enclave-ce7c1b73', 'branch': 'witness-failover',
        'base': 'bfbd649d8c416922691a6dd1eaada8a81765bba5', 'head': 'ce7c1b7309dbc1cb65bedbdf7db5a173c977208c',
        'commits': ['cf5cc363b', 'ce7c1b730'],
        'baseProvenance': 'bfbd649d preserved in 552fb9f5 as frozen-0318-export/witness-enclave-bfbd649d (2 patches on '
                          '9fdc1418c)'},
    'p-history-helios': {
        'repo': base / 'witness-failover/helios', 'name': 'p-history-helios-aca81764', 'branch': 'enclave-witness-check',
        'base': '1ec2c1a52399b6a8d0fc1eb7658bf030987e132a', 'head': 'aca81764f1d41a34829a3b408cea11c5c186e9e9',
        'commits': ['aca81764f'],
        'baseProvenance': '1ec2c1a5 preserved in 552fb9f5 as frozen-0318-export/witness-helios-1ec2c1a5 (1 patch on eeffcc9)'},
    'a-verifier-authority': {
        'repo': base / 'rpc-priority/repo', 'name': 'a-verifier-authority-921d60c2', 'branch': 'rpc-priority',
        'base': NINE, 'head': '921d60c2b37ec8ae64e1fd22d7bc7b408939bd70', 'commits': ['921d60c2b'],
        'baseProvenance': '9fdc1418c = A\'s finished candidate, preserved in 9f40daae as rpc-base-evm-export'},
}
FROZEN = ['witness-failover/RESULT-HISTORY.md', 'witness-failover/PROVENANCE-HISTORY.json',
          'witness-failover/TEST-EVIDENCE-HISTORY.txt']
ROOT_EVIDENCE = ['sia-whole-restore-bounded-reviewed/ROOT-REVIEW.json']


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
s_files = {f['path']: f['sha256'] for f in sides['s-bridge']['changedFiles']}
assert s_files['runner.py'] == '6d2438580b14b1b2beb29ee0b6cc51d74d9a6a10517296836089d3812dc937f2'
assert s_files['whole_restore.py'] == '724cb63918e07d7d3954c7ca577a8431f6da22f87f4a56537cc31161a806adc2'
a_reader = next(f for f in sides['a-verifier-authority']['changedFiles'] if f['path'] == 'network/lease-reader.mjs')
assert a_reader['sha256'] == '3d1850b2ca7161e6efbe35976e9b5050ad56abf67b94ee8c1acc5b0e5a71e37d'   # root's deadline probe source
frozen = {name: sha((base / name).read_bytes()) for name in FROZEN}
evidence = {name: sha((base / name).read_bytes()) for name in ROOT_EVIDENCE}
review = json.loads((base / ROOT_EVIDENCE[0]).read_text())
assert review['sourceCommit'] == SIDES['s-bridge']['head'] and review['files'] == {'runner.py': s_files['runner.py'],
                                                                                  'whole_restore.py': s_files['whole_restore.py']}
inventory = {
    'format': 'enclave-frozen-0331-export/v1',
    'checkpointHeadAtExport': CHECKPOINT_HEAD,
    'label': ('SOURCE + OFFLINE TESTS ONLY. Nothing here is merged into the normal tree, imaged or deployed. s-bridge f98786e9: '
              'bounded selector bridge for the isolated whole-restore harness; offline/loopback tests and a load fixture only, '
              'NEVER a restore pass: the old OOM remains the latest terminal full restore (a new attempt was prepared, not '
              'started, at 03:31Z). e-sia-cache b71c8261: optional S3 cache backend (MinIO unit tests + real-Helios replay), '
              'NOT live Sia; first-writer poisoning availability gap still open. e-receipt-witness b84c5a11: DIAGNOSTIC ONLY, '
              'not policy authority. p-history ce7c1b73/aca81764: authenticated-ancestry root recovery; the combined proof-'
              'call test uses a SYNTHETIC block identity, not real history + proof from one fixture; fresh witness '
              'availability not solved. a-verifier-authority 921d60c2: whole-operation deadline gap identified (root probe), '
              'B fix in progress; A\'s later Reth positive E2E is NOT part of this commit.'),
    'sides': sides,
    'frozenSources': frozen,
    'rootEvidence': evidence,
    'notPreserved': ['worktrees and anything after the exported heads: A 0c43e4db8 (Reth positives) and A\'s untracked '
                     'contracts/foundry/out + node_modules; P\'s new bounded real-proof recording; E\'s compose work against P; '
                     'D/C active work; B deadline 62fe (in progress)',
                     'S: runs/ (generated load reports), logs/, mutants/, d.txt/m1.txt, batch.sh, q.sh, bridge.patch, '
                     'recovered/restored data, binaries; root\'s sia-whole-restore-bounded-reviewed/start-reviewed.sh, its '
                     'runner/whole_restore copies (identical to the tree) and prepare log (remote handles / private paths)',
                     'rpc-sia-cache RESULT.md, compose/, jobs/, logs/, tmp/ and its .patch (exact Git only)',
                     'rpc-receipt-witness untracked probe/bloom-*.out/guard logs',
                     'witness-failover target/, bin/, cargo-home/, logs/, test-scratch/, jobs/, patches/',
                     'all binaries, cargo caches, vendor downloads and private keys/credentials'],
}
(out / 'INVENTORY.json').write_text(json.dumps(inventory, indent=1) + '\n')
print(json.dumps({k: {'commits': len(v['commits']), 'files': len(v['changedFiles']), 'patches': len(v['patches'])}
                  for k, v in sides.items()} | {'frozen': len(frozen), 'rootEvidence': len(evidence),
                                                'inventorySha256': sha((out / 'INVENTORY.json').read_bytes())}))

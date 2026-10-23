"""Export the 08:30Z frozen commits for the checkpoint, from Git OBJECTS only (never from mutable or dirty worktrees).

* a-windows       rpc-priority/repo                     71448f63 -> b56a4699 .. df8fbafa (A: B deadline, ROOT fd6, LeaseReader
                                                         client closure, Windows chain consumers; patches 0010-0014)
* s-root-doc      fresh-witness-supply                  47c2f71f -> bcd3d9ca (ROOT canonical doc correction; tree = dc767fc3's)
* c-storage-write storage-write-release                 ROOT -> 6fd7a929 -> bbf0a009 (C distributed-write cutover package + RESULT)
* f-final (MERGE) host-services-final-compose/candidate 4106c311 = merge(0757085e, 6c38c048): ONE diff against its first parent
* e-derivative    rpc-transaction-independence          ROOT -> a460c36c -> 159fd148 as a SOURCE-ONLY DERIVATIVE: every file
                  except fixtures/artifacts/*.json (7 compiled outputs, recorded by blob/sha256 and with their regeneration
                  recipe frozen-0830-e-artifact-recipe.json); its patches rebuild the DERIVATIVE trees (original tree minus those 7
                  entries), NOT the exact original trees.
Bases: 71448f63, 47c2f71f, 0757085e and 6c38c048 are heads preserved in earlier pushed exports; the rest are root commits.
"""
from pathlib import Path
import hashlib, json, os, shutil, subprocess, tempfile

root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
out = base / 'source-preservation/frozen-0830-export'
checkpoint = root / 'work/source-checkpoint-20261022/main-repo'
CHECKPOINT_HEAD = '842ca044199b5562136c80b2842cffe8374b65aa'
AUTHOR = 'SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'
ART = 'fixtures/artifacts/'
SIDES = {
    'a-windows': {'repo': base / 'rpc-priority/repo', 'name': 'a-windows-df8fbafa', 'branch': 'rpc-priority',
        'base': '71448f63ba189b1f61153e7df766f9421b350205', 'head': 'df8fbafae081321f3c9a9c774e41007200913f32',
        'commits': ['b56a4699', 'f3443e53', '25c051a9', 'e820e240', 'df8fbafa'],
        'baseProvenance': '71448f63 preserved in 871e2197 as frozen-0630-export/a-native-relay-71448f63'},
    's-root-doc': {'repo': root / 'work/fresh-witness-supply', 'name': 's-root-doc-bcd3d9ca', 'branch': 'master',
        'base': '47c2f71f472c973593702b310017f9fd4744e6d1', 'head': 'bcd3d9ca3b4345f42134342dec28ab5f6d4115f2', 'commits': ['bcd3d9ca'],
        'baseProvenance': '47c2f71f preserved in 842ca044 as frozen-0745-export/s-holder-final-47c2f71f'},
    'c-storage-write': {'repo': base / 'storage-write-release', 'name': 'c-storage-write-bbf0a009', 'branch': 'storage/write-release',
        'base': None, 'head': 'bbf0a009b4f823f17a7d7679007b0ad74c49e76f', 'commits': ['6fd7a929', 'bbf0a009'],
        'baseProvenance': 'root commit (C standalone repo)'},
}
MERGE = {'repo': base / 'host-services-final-compose/candidate', 'name': 'f-final-4106c311', 'branch': 'final/host-services-compose',
         'head': '4106c3114dd13f39692195c182d3152efa5e212c', 'parents': ['0757085e5b78ed38efc11920fb3cf4a25d7dfc4d', '6c38c0489d769db12e5037e7c20f7372e56d5620'],
         'baseProvenance': 'first parent 0757085e (C carriers) and second parent 6c38c048 (F lifecycle) preserved in 871e2197 (frozen-0630-export)'}
DERIV = {'repo': root / 'work/rpc-transaction-independence', 'name': 'e-derivative-159fd148', 'branch': 'master',
         'base': None, 'head': '159fd1480ddab9652043cce5163348ff4fa6996b', 'commits': ['a460c36c', '159fd148'],
         'baseProvenance': 'root commit (E standalone repo); SOURCE-ONLY DERIVATIVE (fixtures/artifacts/ excluded)'}
H = 'host-services-final-compose/'
FROZEN = ['rpc-priority/RESULT-WINDOWS-CONSUMERS.md'] + \
    [f'rpc-priority/patches/enclave/{n}' for n in (
        '0010-Bound-the-whole-verified-read-its-callback-included-.patch', '0011-Keep-the-verified-operation-deadline-timer-reference.patch',
        '0012-Close-verified-policy-snapshots-before-late-response.patch', '0013-Close-the-verified-LeaseReader-client-s-metadata-met.patch',
        '0014-Wire-the-Windows-node-s-chain-consumers-to-the-expli.patch')] + \
    [H + n for n in ('RESULT.md', 'PROGRESS.txt', 'artifacts-final.sha256', 'artifacts-final-run1-modified.sha256', 'node-deploy-files.sha256',
                     'node-deploy-files.txt', 'release.sha256', 'build-final.sh', 'job.sh', 'q.sh', 'setup.sh', 'r1-check.sh', 'scan.sh',
                     'merge-msg.txt', 'gitleaks-range.json')] + \
    ['source-preservation/' + n for n in ('frozen-0830-f-final-test-evidence.txt', 'frozen-0830-c-storage-test-evidence.txt',
                                          'frozen-0830-e-artifact-recipe.json', 'snapshots-0830/ROOT-PENDING-LATEST.snapshot-0830.txt',
                                          'snapshots-0830/effective-goal-requirements.snapshot-0830.txt')]
RECIPE_DIR = 'source-preservation/frozen-0830-e-recipe-sources'
ROOT_EVIDENCE = [H + 'ROOT-RPC-CONSUMER-GATE.txt', H + 'ROOT-LIVE-LEGACY-ADMISSION.txt', H + 'ROOT-LIVE-POLICY-PREFLIGHT.txt',
                 '../../outputs/decentralization-audit/checkpoint-verified-0745-20261023.json']


def git(repo, *args, text=True):
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=text).stdout


def sha(data):
    return hashlib.sha256(data).hexdigest()


def export(key, spec, exclude=()):
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
    files = []
    diff_args = [base_full, head] if base_full else ['4b825dc642cb6eb9a060e54bf8d69288fbee4904', head]
    for line in git(repo, 'diff', '--name-status', '--no-renames', *diff_args).splitlines():
        status, path = line.split('\t')
        if any(path.startswith(x) for x in exclude):
            continue
        if status == 'D':
            files.append({'path': path, 'status': 'D', 'baseBlob': git(repo, 'rev-parse', f'{base_full}:{path}').strip()})
            continue
        assert status in ('A', 'M'), line
        blob = git(repo, 'rev-parse', f'{head}:{path}').strip()
        data = git(repo, 'cat-file', 'blob', blob, text=False)
        mode = git(repo, 'ls-tree', head, '--', path).split()[0]
        assert mode in ('100644', '100755', '120000'), (path, mode)   # 120000: files/ holds the link text; the patch carries the link
        data.decode('utf-8')   # every authored file is text; a binary aborts the export
        target = dst / 'files' / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        files.append({'path': path, 'status': status, 'mode': mode, 'blob': blob, 'sha256': sha(data), 'bytes': len(data),
                      'baseBlob': git(repo, 'rev-parse', f'{base_full}:{path}').strip() if status == 'M' else None})
    (dst / 'patches').mkdir(parents=True)
    git(repo, 'format-patch', '--full-index', '--no-renames', '--no-signature', '-o', str(dst / 'patches'),
        *(['--root', head] if not base_full else [rng]), '--', '.', *[f':(exclude){x}' for x in exclude])
    patches = sorted((dst / 'patches').iterdir())
    assert len(patches) == len(rows), f'{key}: {len(patches)} patches for {len(rows)} commits'
    for p in patches:
        p.read_bytes().decode('utf-8')
        assert b'GIT binary patch' not in p.read_bytes(), p
    reach = (subprocess.run(['git', '-C', str(repo), 'merge-base', '--is-ancestor', head, spec['branch']]).returncode == 0
             if spec['branch'] else None)
    return {'repo': str(repo.relative_to(root)), 'branch': spec['branch'], 'headReachableFromBranch': reach,
            'base': base_full, 'baseProvenance': spec['baseProvenance'], 'head': head, 'headTree': rows[-1]['tree'],
            'commits': rows, 'changedFiles': files,
            'patches': [{'file': str(p.relative_to(out)), 'sha256': sha(p.read_bytes())} for p in patches]}



assert git(checkpoint, 'rev-parse', 'HEAD').strip() == CHECKPOINT_HEAD, 'checkpoint HEAD moved'
out.mkdir(exist_ok=True)
for child in out.iterdir():
    if child.name != 'REBUILD.md':
        shutil.rmtree(child) if child.is_dir() else child.unlink()
sides = {k: export(k, s) for k, s in SIDES.items()}
# ---- the merge: one diff against its first parent, every changed file at its blob -----------------------------------------
mr, md = MERGE['repo'], out / MERGE['name']
mh = git(mr, 'rev-parse', MERGE['head'] + '^{commit}').strip(); assert mh == MERGE['head']
row = dict(zip(('commit', 'parents', 'tree', 'author', 'committer', 'committedAt', 'subject'),
               git(mr, 'log', '-1', '--format=%H%x09%P%x09%T%x09%an <%ae>%x09%cn <%ce>%x09%cI%x09%s', mh).strip().split('\t')))
assert row['parents'].split() == MERGE['parents'] and row['author'] == AUTHOR and row['committer'] == AUTHOR
assert subprocess.run(['git', '-C', str(mr), 'merge-base', '--is-ancestor', mh, MERGE['branch']]).returncode == 0
mfiles = []
for line in git(mr, 'diff', '--name-status', '--no-renames', MERGE['parents'][0], mh).splitlines():
    st, p = line.split('\t'); assert st in ('A', 'M'), line
    blob = git(mr, 'rev-parse', f'{mh}:{p}').strip(); data = git(mr, 'cat-file', 'blob', blob, text=False); data.decode('utf-8')
    (md / 'files' / p).parent.mkdir(parents=True, exist_ok=True); (md / 'files' / p).write_bytes(data)
    mfiles.append({'path': p, 'status': st, 'blob': blob, 'sha256': sha(data), 'bytes': len(data)})
(md / 'patches').mkdir(parents=True)
diff = git(mr, 'diff', '--full-index', '--no-renames', MERGE['parents'][0], mh, text=False); assert b'GIT binary patch' not in diff
(md / 'patches' / 'merge-vs-first-parent.diff').write_bytes(diff)
merge = {'repo': str(mr.relative_to(root)), 'branch': MERGE['branch'], 'headReachableFromBranch': True, 'commit': row,
         'firstParent': MERGE['parents'][0], 'secondParent': MERGE['parents'][1], 'baseProvenance': MERGE['baseProvenance'],
         'headTree': row['tree'], 'changedFilesVsFirstParent': mfiles,
         'secondParentDiffStat': git(mr, 'diff', '--stat', MERGE['parents'][1], mh).strip().splitlines()[-1],
         'patches': [{'file': str((md / 'patches' / 'merge-vs-first-parent.diff').relative_to(out)), 'sha256': sha(diff)}]}
# ---- the E source-only derivative ------------------------------------------------------------------------------------------
dr = DERIV['repo']
deriv = export('e-derivative', DERIV, exclude=(ART,))
def derived_tree(commit):          # the original tree minus every fixtures/artifacts/ entry, computed in a throwaway index
    with tempfile.TemporaryDirectory() as t:
        env = {**os.environ, 'GIT_INDEX_FILE': str(Path(t) / 'index')}
        run = lambda *a: subprocess.run(['git', '-C', str(dr), *a], env=env, check=True, capture_output=True, text=True).stdout
        run('read-tree', commit); run('rm', '-q', '--cached', '-r', '--', ART); return run('write-tree').strip()
omitted = {}
for c in deriv['commits']:
    c['originalTree'] = c['tree']; c['tree'] = derived_tree(c['commit'])
    omitted[c['commit']] = [dict(zip(('mode', 'type', 'blob', 'bytes', 'path'), l.split(None, 4)))
                            for l in git(dr, 'ls-tree', '-r', '-l', c['commit'], '--', ART).splitlines()]
deriv['originalHeadTree'] = deriv['headTree']; deriv['headTree'] = deriv['commits'][-1]['tree']
deriv['omittedArtifacts'] = omitted
recipe = json.loads((base / 'source-preservation/frozen-0830-e-artifact-recipe.json').read_text())
deriv['artifactRecipe'] = {'file': 'source-preservation/frozen-0830-e-artifact-recipe.json', 'compilerPin': recipe['compilerPin'],
                           'recipeSourcesMatched': len(recipe['recipeSources']['matched']), 'recipeSourcesMissing': recipe['recipeSources']['missing']}
deriv['label'] = ('SOURCE-ONLY DERIVATIVE: the exact original commit trees CANNOT be rebuilt from this export until the 7 compiled '
                  'fixtures are regenerated (solc 0.8.35+commit.47b9dedd, viaIR, runs 1, the pinned sources) and reproduce the recorded '
                  'bytecode keccak256s; these patches reproduce the derivative trees (original minus fixtures/artifacts/)')
assert recipe['commits']['report']['commit'] == DERIV['head'] and recipe['artifactsIdenticalInBothCommits'] is True
assert not recipe['recipeSources']['missing'] and recipe['compilerPin'] == ['0.8.35+commit.47b9dedd']
for c in deriv['commits']:
    want = {(a['path'], a['blob']) for a in recipe['commits']['report' if c['commit'] == DERIV['head'] else 'initial']['artifacts']}
    assert {(a['path'], a['blob']) for a in omitted[c['commit']]} == want, 'recipe and omitted artifacts disagree'
assert not any(f['path'].startswith(ART) for f in deriv['changedFiles'])
for p in deriv['patches']: assert b'diff --git a/fixtures/artifacts/' not in (out / p['file']).read_bytes(), p   # no artifact FILE (the test still names the path)
# ---- facts -----------------------------------------------------------------------------------------------------------------
assert sides['s-root-doc']['headTree'] == '4c50bc8c49fdbf975df405efc94137762d5cf6aa'
assert merge['headTree'] == git(mr, 'rev-parse', mh + '^{tree}').strip()
cv = json.loads((root / 'outputs/decentralization-audit/checkpoint-verified-0745-20261023.json').read_text())
assert '842ca044199b5562136c80b2842cffe8374b65aa' in json.dumps(cv) and '7752a4239b3bec2cf452491cd1b95164a8c2bdb8' in json.dumps(cv)
frozen = {name: sha((base / name).read_bytes()) for name in FROZEN}
for p in sorted((base / RECIPE_DIR).rglob('*')):
    if p.is_file(): frozen[str(p.relative_to(base))] = sha(p.read_bytes())
evidence = {name: sha((base / name).resolve().read_bytes()) for name in ROOT_EVIDENCE}
inventory = {'format': 'enclave-frozen-0830-export/v1', 'checkpointHeadAtExport': CHECKPOINT_HEAD,
    'label': ('SOURCE + OFFLINE TESTS ONLY. Nothing here is merged into the normal tree, imaged, deployed or activated. Terminal '
              'immutable heads since 842ca044: A df8fbafa, ROOT bcd3d9ca (canonical doc correction), C bbf0a009 (on 6fd7a929), F merge '
              '4106c311, and E 159fd148 as a source-only derivative.'),
    'sides': sides, 'merge': merge, 'derivative': deriv, 'frozenSources': frozen, 'rootEvidence': evidence,
    'notPreserved': ['E fixtures/artifacts/*.json (7 compiled outputs; blobs, sha256 and the regeneration recipe recorded instead)',
                     'F host-services-final-compose/release/ (built artifacts; their hashes are in release.sha256 / artifacts-final.sha256)',
                     'raw logs (F/C digests instead), run handles, keys, binaries, node_modules, build caches',
                     'later mutable work: A after df8fbafa, F host-service-rpc-closure, C after bbf0a009, S browser-rpc-closure, E closure',
                     'C storage-write-release/ROOT-LIVE-*.txt (byte-identical to the F copies captured here)',
                     'rpc-priority/patches/SHA256SUMS update (path already in the manifest; the Git-object patches are authoritative)']}
(out / 'INVENTORY.json').write_text(json.dumps(inventory, indent=1) + '\n')
print(json.dumps({k: {'commits': len(v['commits']), 'files': len(v['changedFiles'])} for k, v in sides.items()}
                 | {'merge-files': len(mfiles), 'derivative': {'commits': len(deriv['commits']), 'files': len(deriv['changedFiles']),
                    'trees': [c['tree'][:8] for c in deriv['commits']]}, 'frozen': len(frozen), 'rootEvidence': len(evidence),
                    'inventorySha256': sha((out / 'INVENTORY.json').read_bytes())}))

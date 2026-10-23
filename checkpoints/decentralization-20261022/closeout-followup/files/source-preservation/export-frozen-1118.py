"""Export the frozen-1118 batch for the checkpoint, from Git OBJECTS only (never from mutable or dirty worktrees). "1118" is the batch
IDENTIFIER = its actual start, 2026-10-23T11:18Z (date -u); it is not a publication time.

Linear series on a base already preserved in pushed checkpoint material (f2db53ff), or root commits:
* tls-m          windows-memory-accounting-20261023/repo  4106c311 -> 1957ff23, 6f6d22f5 (TLS worker final source + report; the same
                 commits are HEAD of nucbox-tls-recovery-20261023/candidate) -> 9f19b7c6 (M Windows HV memory accounting final)
* s-compose      rpc-storage-final-compose/s               bcd3d9ca -> c74e302c, 92b71784 (S composed holder storage + cache runbook)
* rsfc-report    rpc-storage-final-compose (report repo)   root -> ccb55b83, dd5c9a59
* root-ram96, root-allowlist, root-iface, root-mem, root-main-delta, root-capacity, root-immutability: ROOT repos, root commits
* cache-boundary cache-native-boundary-20261023            root -> 7 commits -> ea676d8 (P kernel cache test + fixes, terminal)
SOURCE-ONLY DERIVATIVES (patches rebuild the DERIVATIVE trees, NOT the exact originals):
* p-compose      rpc-storage-final-compose/p  f8351487 (derivative in f2db53ff) -> f8c999ed, minus the same 5 paths as frozen-0931 p-l1
* e-final        rpc-transaction-independence  ca818b75 (derivative in f2db53ff) -> 7 commits -> 9c5e0ee, minus fixtures/artifacts/ and
                 exports/ (as frozen-0931); no artifact changes in this range, so frozen-0931's recipe still pins all 13
"""
from pathlib import Path
import hashlib, json, os, shutil, subprocess, tempfile

root = Path(__file__).resolve().parents[3]
W = root / 'work'
base = W / 'resume-after-checkpoint-20261022'
sp = base / 'source-preservation'
out = sp / 'frozen-1118-export'
checkpoint = W / 'source-checkpoint-20261022/main-repo'
CHECKPOINT_HEAD = 'f2db53ff5691fa691760ce2a102126291a1354f6'
AUTHOR = 'SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'
# OLD = the former provider name the 2026-10-21 repository rewrite replaced by 'Cloud Provider'; built from hex so this tool
# itself does not carry the literal it guards against
OLD = bytes.fromhex('54696e666f696c')
R = lambda repo, name, branch, b, head, commits, prov, **kw: {'repo': repo, 'name': name, 'branch': branch, 'base': b, 'head': head,
                                                              'commits': commits.split(), 'baseProvenance': prov, **kw}
ROOTC = 'root commit (ROOT repo)'
SIDES = {
    'tls-m': R(W / 'windows-memory-accounting-20261023/repo', 'tls-m-9f19b7c6', 'windows-memory-accounting', '4106c3114dd13f39692195c182d3152efa5e212c',
               '9f19b7c66c156dc3f1052ece121de89e4c741912', '1957ff23 6f6d22f5 9f19b7c6',
               '4106c311 preserved in f2db53ff (frozen-0830 f-final merge; frozen-0931 f-rpc-closure base)'),
    's-compose': R(W / 'rpc-storage-final-compose/s', 's-compose-92b71784', 'storage-final-compose', 'bcd3d9ca3b4345f42134342dec28ab5f6d4115f2',
                   '92b71784c9452056eeeb6a97b8e1fcb8ef1815ca', 'c74e302c 92b71784', 'bcd3d9ca preserved in f2db53ff as frozen-0830 s-root-doc'),
    'rsfc-report': R(W / 'rpc-storage-final-compose', 'rsfc-report-dd5c9a59', 'main', None, 'dd5c9a599ab1a298396724f2a0c5de41b70df080', 'ccb55b83 dd5c9a59',
                     'root commit (P/S storage final compose report repo)'),
    'root-ram96': R(W / 'nucbox-ram96-20261023', 'root-ram96-dd7e7af8', 'master', None, 'dd7e7af849e641be10e61e92be266e9ecea93722', 'd3b8e687 2851f923 dd7e7af8', ROOTC),
    'root-allowlist': R(W / 'root-public-rpc-allowlist-review-20261023', 'root-allowlist-a6186636', 'master', None, 'a6186636a4a94cb4fc20a83b06f905b0b1721312', 'a6186636', ROOTC),
    'root-iface': R(W / 'root-rpc-interface-review-20261023', 'root-iface-73a2c086', 'master', None, '73a2c08645a3066f3965bc903001d84a2ef4d8e4', '73a2c086', ROOTC),
    'root-mem': R(W / 'root-nucbox-memory-accounting-20261023', 'root-mem-c1f35cf5', 'master', None, 'c1f35cf580d60fe600ffb43c3bc6dbbcb6b1b6fa', 'c1f35cf5', ROOTC),
    'root-main-delta': R(W / 'root-main-delta-20261023', 'root-main-delta-2d78c982', 'master', None, '2d78c982ee9f92cfe6622c1bdf181616cf39cea9', '2d78c982', ROOTC),
    'root-capacity': R(base / 'root-rpc-host-capacity', 'root-capacity-f397cbf1', 'master', None, 'f397cbf1c85a670301bcf34a6d2fcd2fbecd9462', 'f397cbf1', ROOTC),
    'root-immutability': R(base / 'root-evidence-immutability-review', 'root-immutability-b0236c87', 'master', None, 'b0236c87e693d8ada2cfd147c7e0703e11abc3b9', 'b0236c87', ROOTC),
    'cache-boundary': R(W / 'cache-native-boundary-20261023', 'cache-boundary-ea676d8b', 'main', None, 'ea676d8bbae095f71c4d969e7a02e91b3c7c3d43',
                        '94a5f26a 6a56ddb9 01eb7583 9ac11f1c 195df78b ff4406ed ea676d8b', 'root commit (P cache-native-boundary repo)'),
}
F931 = json.loads((sp / 'frozen-0931-export/INVENTORY.json').read_text())
P_EXCL = tuple(F931['derivatives']['p-l1']['excluded'])
DERIVS = {
    'p-compose': R(W / 'rpc-storage-final-compose/p', 'p-compose-f8c999ed', 'storage-final-compose', 'f83514874646d3be1ea46bc420f0fed5e664f6ef',
                   'f8c999ed5a9600ef477ff05ee00b31dee366b2b1', 'f8c999ed', 'f8351487 preserved in f2db53ff as the source-only derivative frozen-0931 p-l1',
                   exclude=P_EXCL),
    'e-final': R(W / 'rpc-transaction-independence', 'e-final-9c5e0eef', 'master', 'ca818b759172adc98c5089796784133f9310e597',
                 '9c5e0eefd3836f64675211ad02effc40a8eacc36', 'a194afe2 46dbfbef 901d7b31 029fdefe c08331e9 e917c526 9c5e0eef',
                 'ca818b75 preserved in f2db53ff as the source-only derivative frozen-0931 e-closure', exclude=tuple(F931['derivatives']['e-closure']['excluded'])),
}
MW = '../windows-memory-accounting-20261023/'
FROZEN = ([MW + n for n in ('RESULT.md', 'RESULT.json', 'F-HANDOFF.txt', 'PROGRESS.txt', 'commit-msg.txt', 'windows-memory-accounting.patch',
                            'j1-new.sh', 'j2-negctl.sh', 'j3-coupled.sh', 'j4-fixtures.sh', 'j5-commit.sh', 'q.sh')]
          + ['source-preservation/' + n for n in ('RESULT-frozen-0931-checkpoint.md', 'frozen-1118-m-memory-test-evidence.txt',
             'snapshots-1118/ROOT-PENDING-LATEST.snapshot-1118.txt', 'snapshots-1118/effective-goal-requirements.snapshot-1118.txt')])
ROOT_EVIDENCE = (['source-preservation/' + n for n in ('ROOT-E-IMMUTABILITY-FINAL.txt', 'ROOT-MAIN-ADVANCED.txt', 'ROOT-MEMORY-ACCOUNTING-OWNER.txt')]
                 + ['windows-upgrade-delta-review/ROOT-TLS-FINAL.txt', '../rpc-storage-final-compose/ROOT-KERNEL-DELTA-REVIEW.txt']
                 + ['../../outputs/decentralization-audit/' + n for n in ('checkpoint-push-observed-20261023.json', 'checkpoint-remote-20261023T1035.json',
                    'main-delta-20261023.json', 'nucbox-memory-accounting-review-20261023.json', 'nucbox-ram96-20261023.json',
                    'public-rpc-allowlist-review-20261023.json', 'rpc-interface-review-20261023.json', 'transaction-evidence-mutation-20261023.json',
                    'rpc-nucbox-target-20261023T094534Z.json', 'rpc-integration-review-20261023-0935.txt')])


def git(repo, *args, text=True, env=None):
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=text, env=env).stdout


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
        assert status in ('A', 'M', 'T'), line
        blob = git(repo, 'rev-parse', f'{head}:{path}').strip()
        data = git(repo, 'cat-file', 'blob', blob, text=False)
        mode = git(repo, 'ls-tree', head, '--', path).split()[0]
        assert mode in ('100644', '100755', '120000'), (path, mode)   # 120000: files/ holds the link text; the patch carries the link
        data.decode('utf-8')   # every exported file is text; a binary aborts the export
        target = dst / 'files' / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        files.append({'path': path, 'status': status, 'mode': mode, 'blob': blob, 'sha256': sha(data), 'bytes': len(data),
                      'baseBlob': git(repo, 'rev-parse', f'{base_full}:{path}').strip() if status in ('M', 'T') else None})
    (dst / 'patches').mkdir(parents=True)
    git(repo, 'format-patch', '--full-index', '--no-renames', '--no-signature', '-o', str(dst / 'patches'),
        *(['--root', head] if not base_full else [rng]), '--', '.', *[f':(exclude){x}' for x in exclude])
    patches = sorted((dst / 'patches').iterdir())
    # a commit that only touches excluded paths has no derivative patch (format-patch's pathspec walk skips it): recorded, and
    # the verifier checks the derived tree is unchanged across it
    for r in rows:
        r['emptyAfterExclusion'] = bool(exclude) and subprocess.run(['git', '-C', str(repo), 'diff', '--quiet', r['parent'], r['commit'], '--', '.',
                                                                    *[f':(exclude){x}' for x in exclude]]).returncode == 0
    assert len(patches) == sum(not r['emptyAfterExclusion'] for r in rows), f'{key}: {len(patches)} patches for {len(rows)} commits'
    for p in patches:
        p.read_bytes().decode('utf-8')
        assert b'GIT binary patch' not in p.read_bytes(), p
        for x in exclude: assert f'diff --git a/{x}'.encode() not in p.read_bytes(), (p, x)
    reach = subprocess.run(['git', '-C', str(repo), 'merge-base', '--is-ancestor', head, spec['branch']]).returncode == 0
    assert reach, f'{key}: head not on {spec["branch"]}'
    return {'repo': str(repo.relative_to(root)), 'branch': spec['branch'], 'headReachableFromBranch': reach,
            'base': base_full, 'baseProvenance': spec['baseProvenance'], 'head': head, 'headTree': rows[-1]['tree'],
            'commits': rows, 'changedFiles': files,
            'patches': [{'file': str(p.relative_to(out)), 'sha256': sha(p.read_bytes())} for p in patches]}


def derived_tree(repo, commit, exclude):   # the original tree minus every excluded entry, in a throwaway index
    with tempfile.TemporaryDirectory() as t:
        env = {**os.environ, 'GIT_INDEX_FILE': str(Path(t) / 'index')}
        run = lambda *a: subprocess.run(['git', '-C', str(repo), *a], env=env, check=True, capture_output=True, text=True).stdout
        run('read-tree', commit)
        for x in exclude:
            run('rm', '-q', '-f', '--cached', '-r', '--ignore-unmatch', '--', x)   # -f: skip the worktree up-to-date check; only the throwaway index changes
        return run('write-tree').strip()


assert git(checkpoint, 'rev-parse', 'HEAD').strip() == CHECKPOINT_HEAD, 'checkpoint HEAD moved'
out.mkdir(exist_ok=True)
for child in out.iterdir():
    if child.name != 'REBUILD.md':
        shutil.rmtree(child) if child.is_dir() else child.unlink()
sides = {k: export(k, s) for k, s in SIDES.items()}
# the TLS worker's own repository holds the same two commits as its HEAD (exported here as tls-m's first two)
tls_repo = W / 'nucbox-tls-recovery-20261023/candidate'
assert git(tls_repo, 'rev-parse', 'HEAD').strip() == sides['tls-m']['commits'][1]['commit'] == '6f6d22f5da31bb40b3131deb1f719291602682d0'
assert git(tls_repo, 'rev-parse', 'HEAD~1').strip() == sides['tls-m']['commits'][0]['commit'] and not git(tls_repo, 'status', '--porcelain', '--untracked-files=no').strip()
sides['tls-m']['tlsWorkerRepo'] = {'repo': str(tls_repo.relative_to(root)), 'head': '6f6d22f5da31bb40b3131deb1f719291602682d0', 'branch': git(tls_repo, 'rev-parse', '--abbrev-ref', 'HEAD').strip()}
mpatch = sha((W / 'windows-memory-accounting-20261023/windows-memory-accounting.patch').read_bytes())
assert mpatch == 'eeab54d2292a49341125f249a1124ff7bc2a042aa6bec90800c5af681491cb92', 'M final patch hash (root ROOT-PENDING)'
derivs = {}
for k, s in DERIVS.items():
    d = export(k, s, exclude=s['exclude'])
    omitted = {}
    for c in d['commits']:
        c['originalTree'] = c['tree']; c['tree'] = derived_tree(s['repo'], c['commit'], s['exclude'])
        omitted[c['commit']] = [dict(zip(('mode', 'type', 'blob', 'bytes', 'path'), l.split(None, 4)))
                                for x in s['exclude'] for l in git(s['repo'], 'ls-tree', '-r', '-l', c['commit'], '--', x).splitlines()]
    d['originalHeadTree'] = d['headTree']; d['headTree'] = d['commits'][-1]['tree']
    d['omittedAtHead'] = omitted[d['head']]; d['excluded'] = list(s['exclude'])
    derivs[k] = d
# p-compose: the omitted paths are byte-identical to frozen-0931 p-l1's (same blobs) -> its omittedRecipe/omittedFingerprintFiles apply
p931 = F931['derivatives']['p-l1']
assert {(a['path'], a['blob']) for a in derivs['p-compose']['omittedAtHead']} == {(a['path'], a['blob']) for a in p931['omittedAtHead']}
derivs['p-compose']['omittedRecipe'] = 'unchanged since frozen-0931 p-l1: its omittedRecipe (upstream zip) and omittedFingerprintFiles apply (identical blobs)'
derivs['p-compose']['label'] = 'SOURCE-ONLY DERIVATIVE: exact original trees need the 5 frozen-0931 p-l1 omitted files restored (identical blobs)'
# e-final: compiled fixtures unchanged since ca818b75 -> frozen-0931-e-artifact-recipe.json pins all 13; exports/ now holds E's own
# source-only patch series (it embeds the rewritten literal in one patch and duplicates the Git objects) -> omitted, recorded
e = derivs['e-final']
recipe = json.loads((sp / 'frozen-0931-e-artifact-recipe.json').read_text())
arts = [a for a in e['omittedAtHead'] if a['path'].startswith('fixtures/artifacts/')]
assert {(a['path'], a['blob']) for a in arts} == {(a['path'], a['blob']) for a in recipe['artifacts']}, 'E artifacts changed since frozen-0931'
e['artifactRecipe'] = 'source-preservation/frozen-0931-e-artifact-recipe.json (all 13 artifacts unchanged, identical blobs)'
e['exportsOmitted'] = [{**a, 'sha256': sha(git(DERIVS['e-final']['repo'], 'cat-file', 'blob', a['blob'], text=False))} for a in e['omittedAtHead'] if a['path'].startswith('exports/')]
e['label'] = ('SOURCE-ONLY DERIVATIVE on ca818b75\'s derivative tree: original minus fixtures/artifacts/ (13 compiled fixtures, recipe frozen-0931) '
              'and exports/ (E\'s own patch exports incl. exports/source-only/ARTIFACT-RECIPE.json; they duplicate the Git objects). Exact '
              'original trees NOT reproduced. NOTE: frozen-0931 published E\'s evidence/capture/*.json (public-chain bytecode captures), which '
              'E\'s own source-only export treats as non-source; unchanged in this range, not re-exported, prior entries not altered')
# ---- literal guard ----------------------------------------------------------------------------------------------------------
lit = {}
for f in out.rglob('*'):
    if f.is_file():
        b = f.read_bytes(); n = (b.count(OLD), b.count(OLD.lower()))
        if any(n): lit[str(f.relative_to(out))] = n
for name in FROZEN + ROOT_EVIDENCE:
    b = (base / name).resolve().read_bytes(); n = (b.count(OLD), b.count(OLD.lower()))
    if any(n): lit['frozen:' + name] = n
assert not any(v[0] for v in lit.values()), ('capitalised rewritten literal in export', {k: v for k, v in lit.items() if v[0]})
frozen = {name: sha((base / name).resolve().read_bytes()) for name in FROZEN}
evidence = {name: sha((base / name).resolve().read_bytes()) for name in ROOT_EVIDENCE}
inventory = {'format': 'enclave-frozen-1118-export/v1', 'checkpointHeadAtExport': CHECKPOINT_HEAD,
    'batch': '1118 = the batch start 2026-10-23T11:18Z (date -u): an identifier, not a publication time',
    'label': ('SOURCE + OFFLINE TESTS ONLY. Nothing here is merged into the normal tree, imaged, deployed or activated. Terminal immutable heads '
              'since f2db53ff: TLS worker 1957ff23/6f6d22f5 and M 9f19b7c6 (patch eeab54d2; source accepted for F composition, NOT native-verified), '
              'S 92b71784 and report dd5c9a59, P cache-native-boundary ea676d8b, ROOT ram96 dd7e7af8 (configured 96 / active 64, activation NOT '
              'executed), allowlist a6186636, interface 73a2c086, memory c1f35cf5, main-delta 2d78c982, capacity f397cbf1, immutability b0236c87; '
              'P f8c999ed and E 9c5e0eef as source-only derivatives.'),
    'sides': sides, 'derivatives': derivs, 'lowercaseRewrittenLiteral': lit, 'frozenSources': frozen, 'rootEvidence': evidence,
    'notPreserved': ['P/E omitted files as frozen-0931 (identical blobs) and E exports/ (recorded by blob/sha256)',
                     'untracked/ignored files in every repo (e.g. nucbox-ram96 activation-readiness.*, before.json, *.log; root-rpc-host-capacity guard logs)',
                     'outputs/decentralization-audit/api-mcp-startup-relay-20261023T094137Z.json (an operational probe outside this batch\'s reviews)',
                     'raw logs (M digest instead), binaries, node_modules, build caches',
                     'ACTIVE work: P cache-composed-kernel-delta (new), E rpc-wallet-dependency (new), A/B/C/F/S/T and F windows-final-baseline-compose '
                     '(incl. its ROOT-MEMORY-ACCOUNTING-FINAL.txt), the rpc-storage-final-compose untracked scratch/ and P/S new outputs',
                     'S NOTE files and any handoff note not written by root']}
(out / 'INVENTORY.json').write_text(json.dumps(inventory, indent=1) + '\n')
print(json.dumps({k: {'commits': len(v['commits']), 'files': len(v['changedFiles'])} for k, v in {**sides, **derivs}.items()}
                 | {'frozen': len(frozen), 'rootEvidence': len(evidence), 'literalFiles': len(lit), 'inventorySha256': sha((out / 'INVENTORY.json').read_bytes())}))

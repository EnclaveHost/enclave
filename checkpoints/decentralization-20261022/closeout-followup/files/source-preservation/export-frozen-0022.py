"""Export the frozen-0022 batch (2026-10-24) for the checkpoint, from Git OBJECTS only (never from mutable or dirty worktrees; ignored and
untracked files are never read). "0022" is the batch IDENTIFIER = its actual start, 2026-10-24T00:21:55Z (date -u). Exactly root's designated,
already-committed heads; every WIP (M and D new source), the live repo's newer 3055ee7 and runtime state are excluded.

* boot-fee-release  custody-boot-fee-release-20261023 root -> 979a9ef, efecad2, 3562faa1 (root's approved 5db2be3f build metadata)
* gate-v5           custody-operational-gate-v5-20261023 root -> f5077c21 (proposal, source only)
* lease-keeper      custody-protected-lease-keeper-20261023 root -> b3c298c0 (temporary keeper source)
* m-funding         custody-operator-funding-options-20261023 root -> 76ab248, fe7e1057 (assessment + unsigned plan builder)
* current-docs5     custody-v2-current-docs-20261023 155a23f4 (frozen-2355 current-docs4 head) -> cd4f51a3
plus the 2355 receipt and an exact snapshot of root's public keeper receipt (custody-temporary-lease-protection-20261023.json, 00:01:40Z).
"""
from pathlib import Path
import hashlib, json, os, re, shutil, subprocess, tempfile

root = Path(__file__).resolve().parents[3]
W = root / 'work'
base = W / 'resume-after-checkpoint-20261022'
sp = base / 'source-preservation'
out = sp / 'frozen-0022-export'
checkpoint = W / 'source-checkpoint-20261022/main-repo'
CHECKPOINT_HEAD = '1a69ae562aaf41f73dfc0db303a3507a7f9a5458'
AUTHOR = 'SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'
OLD = bytes.fromhex('54696e666f696c')
PKBLOCK = bytes.fromhex('50524956415445204b45592d2d2d2d2d')
R = lambda repo, name, branch, b, head, commits, prov, **kw: {'repo': repo, 'name': name, 'branch': branch, 'base': b, 'head': head,
                                                              'commits': commits.split(), 'baseProvenance': prov, **kw}
ROOTC = 'root commit'
SIDES = {
    'boot-fee-release': R(W / 'custody-boot-fee-release-20261023', 'boot-fee-release-3562faa1', 'main', None,
                          '3562faa1f3a26b331f79c17105e39f6d4cc082a0', '979a9ef efecad2 3562faa', ROOTC),
    'gate-v5': R(W / 'custody-operational-gate-v5-20261023', 'gate-v5-f5077c21', 'main', None,
                 'f5077c2104ca87f2f1a7eaf60c1dd36ac8373a4c', 'f5077c2', ROOTC),
    'lease-keeper': R(W / 'custody-protected-lease-keeper-20261023', 'lease-keeper-b3c298c0', 'main', None,
                      'b3c298c0855ea8687e0edd1338f5ad870b25dcb3', 'b3c298c', ROOTC),
    'm-funding': R(W / 'custody-operator-funding-options-20261023', 'm-funding-fe7e1057', 'master', None,
                   'fe7e105750fc0e26b009f580c21fea410f339935', '76ab248 fe7e105', ROOTC),
    'current-docs5': R(W / 'custody-v2-current-docs-20261023', 'current-docs5-cd4f51a3', 'master', '155a23f450189d26eb045d2fb5f430d595250132',
                       'cd4f51a31e1d04ceaf029818a7f1c182747a708b', 'cd4f51a3', '155a23f4 preserved in 1a69ae56 (frozen-2355 current-docs4 head)'),
}
DERIVS = {}
FROZEN = ['source-preservation/RESULT-frozen-2355-checkpoint.md',
          'source-preservation/snapshots-0022/custody-temporary-lease-protection-20261023.snapshot-0022.json']
ROOT_EVIDENCE = []
PIN = {'source-preservation/snapshots-0022/custody-temporary-lease-protection-20261023.snapshot-0022.json': 'bb8ab3e2f09798f6'}


import atexit
_ATTR = tempfile.NamedTemporaryFile('w', suffix='.attributes', delete=False); _ATTR.write('* diff=nofunc0022\n'); _ATTR.close(); atexit.register(os.unlink, _ATTR.name)
NOFUNC = ('-c', f'core.attributesFile={_ATTR.name}', '-c', 'diff.nofunc0022.xfuncname=^$')


def git(repo, *args, text=True, env=None):
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=text, env=env).stdout


def sha(data):
    return hashlib.sha256(data).hexdigest()


def excluded(path, x):   # a directory prefix ends in '/'; anything else is ONE exact path (git pathspec semantics)
    return path.startswith(x) if x.endswith('/') else path == x


def export(key, spec, exclude=()):
    # a FIRST-PARENT series: one patch per commit (format-patch of <first parent>..<commit>); a merge is ONE diff against its first
    # parent (the frozen-0830 merge convention, its second parent recorded); a commit touching only excluded paths has no patch
    repo, dst = spec['repo'], out / spec['name']
    head = git(repo, 'rev-parse', spec['head'] + '^{commit}').strip()
    assert head == spec['head'], f'{key}: {spec["head"]} resolves to {head}'
    base_full = git(repo, 'rev-parse', spec['base'] + '^{commit}').strip() if spec['base'] else None
    assert base_full == spec['base'], key
    rng = f'{base_full}..{head}' if base_full else head
    log = git(repo, 'log', '--reverse', '--first-parent', '--format=%H%x09%P%x09%T%x09%an <%ae>%x09%cn <%ce>%x09%cI%x09%s', rng).splitlines()
    rows = [dict(zip(('commit', 'parents', 'tree', 'author', 'committer', 'committedAt', 'subject'), l.split('\t'))) for l in log]
    for r in rows:
        ps = r.pop('parents').split(); r['parent'] = ps[0] if ps else ''
        if len(ps) > 1: r['mergedParents'] = ps[1:]
    assert len(rows) == len(spec['commits']) and [r['commit'][:len(c)] for r, c in zip(rows, spec['commits'])] == spec['commits'], \
        f"{key}: commits {[r['commit'][:9] for r in rows]} != {spec['commits']}"
    assert rows[0]['parent'] == (base_full or ''), f'{key}: first parent'
    assert all(rows[i]['parent'] == rows[i - 1]['commit'] for i in range(1, len(rows))), f'{key}: not a first-parent series'
    assert all(r['author'] == AUTHOR and r['committer'] == AUTHOR for r in rows), f'{key}: unexpected author/committer'
    assert set(spec.get('merges', ())) == {r['commit'] for r in rows if 'mergedParents' in r}, f'{key}: unexpected merges'
    files = []
    diff_args = [base_full, head] if base_full else ['4b825dc642cb6eb9a060e54bf8d69288fbee4904', head]
    for line in git(repo, 'diff', '--name-status', '--no-renames', *diff_args).splitlines():
        status, path = line.split('\t')
        if any(excluded(path, x) for x in exclude):
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
    spec_x = ['--', '.', *[f':(exclude){x}' for x in exclude]]
    patches = []
    for n, r in enumerate(rows, 1):
        c, p1 = r['commit'], r['parent'] or '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
        r['emptyAfterExclusion'] = subprocess.run(['git', '-C', str(repo), 'diff', '--quiet', p1, c, *spec_x]).returncode == 0
        if r['emptyAfterExclusion']:
            assert exclude or 'mergedParents' in r, f'{key}: empty commit {c} with nothing excluded'
            continue
        if 'mergedParents' in r:
            body = git(repo, *NOFUNC, 'diff', '--full-index', '--no-renames', p1, c, *spec_x, text=False)
            data = (f'# merge {c} (first parent {p1}; merged {", ".join(r["mergedParents"])})\n# one diff against the first parent\n').encode() + body
            f = dst / 'patches' / f'{n:04d}-merge-{c[:8]}.diff'
        else:
            data = git(repo, *NOFUNC, 'format-patch', '--stdout', '--full-index', '--no-renames', '--no-signature',
                       *(['--root', '-1', c] if not r['parent'] else [f'{p1}..{c}']), *spec_x, text=False)
            f = dst / 'patches' / f'{n:04d}-{c[:8]}.patch'
        assert data.strip(), (key, c)
        f.write_bytes(data); r['patch'] = str(f.relative_to(out)); patches.append(f)
    for p in patches:
        p.read_bytes().decode('utf-8')
        assert b'GIT binary patch' not in p.read_bytes(), p
        for x in exclude: assert (f'diff --git a/{x}'.encode() if x.endswith('/') else f'diff --git a/{x} '.encode()) not in p.read_bytes(), (p, x)
    reach = subprocess.run(['git', '-C', str(repo), 'merge-base', '--is-ancestor', head, spec['branch']]).returncode == 0
    assert reach, f'{key}: head not on {spec["branch"]}'
    return {'repo': str(repo.relative_to(root)), 'branch': spec['branch'], 'headReachableFromBranch': reach,
            'base': base_full, 'baseProvenance': spec['baseProvenance'], 'head': head, 'headTree': rows[-1]['tree'],
            'commits': rows, 'changedFiles': files,
            'patches': [{'file': str(p.relative_to(out)), 'sha256': sha(p.read_bytes())} for p in patches]}


def derived_tree(repo, commit, exclude, base_commit=None):
    # the original tree with every EXCLUDED path held at the derivative base's state: absent if the base lacks it (root commits),
    # else the base's own blob (a-gaps: the exactly preserved e32dd607 already carries the older compiled bundle)
    with tempfile.TemporaryDirectory() as t:
        env = {**os.environ, 'GIT_INDEX_FILE': str(Path(t) / 'index')}
        run = lambda *a, **kw: subprocess.run(['git', '-C', str(repo), *a], env=env, check=True, capture_output=True, text=True, **kw).stdout
        run('read-tree', commit)
        for x in exclude:
            run('rm', '-q', '-f', '--cached', '-r', '--ignore-unmatch', '--', x)   # -f: skip the worktree up-to-date check; only the throwaway index changes
            if base_commit:
                held = ''.join(f"{l.split()[0]} {l.split()[2]}\t{l.split(chr(9), 1)[1]}\n" for l in run('ls-tree', '-r', base_commit, '--', x).splitlines())
                if held: run('update-index', '--index-info', input=held)
        return run('write-tree').strip()


assert git(checkpoint, 'rev-parse', 'HEAD').strip() == CHECKPOINT_HEAD, 'checkpoint HEAD moved'
out.mkdir(exist_ok=True)
for child in out.iterdir():
    if child.name != 'REBUILD.md':
        shutil.rmtree(child) if child.is_dir() else child.unlink()
sides = {k: export(k, s, exclude=s.get('exclude', ())) for k, s in SIDES.items()}
TREES = {'boot-fee-release': '5bab0fae', 'gate-v5': 'fcb9c4aa', 'lease-keeper': '2377d955', 'm-funding': 'da27a9ca', 'current-docs5': 'a7aa848a'}
NOPE = ('.exe', '.bin', '.wasm', '.zip', '.tar', '.gz', '.dll', '.pdb', '.key', '.img', '.qcow2', '.raw', '.sealed', '.so', '.rlib', '.cwasm', 'vmlinuz', '.cpio')
def forbidden(side): return [f['path'] for f in side['changedFiles'] if f['path'].endswith(NOPE) or 'node_modules/' in f['path'] or 'raw' in Path(f['path']).name.lower()
                             or 'private' in f['path'] or Path(f['path']).name.startswith('ROOT-')]
assert not [p for s in sides.values() for p in forbidden(s)]
INV = 'checkpoints/decentralization-20261022/closeout-followup/files/source-preservation/frozen-{}-export/INVENTORY.json'
F2355 = json.loads(git(checkpoint, 'show', f'{CHECKPOINT_HEAD}:' + INV.format('2355')))
for k, want in (('current-docs5', 'current-docs4'),):
    assert sides[k]['base'] == F2355['sides'][want]['head'] and sides[k]['commits'][0]['parent'] == F2355['sides'][want]['head'], (k, 'base is not the pushed frozen-2355 head')
NOTES = {
 'boot-fee-release': ('boot-fee release: build template for the explicit-sender child of 9f6d37bd (979a9ef) and root\'s approved 5db2be3f build '
                      'record (bc731956) as public metadata (efecad2, 3562faa1). No image binaries. The image was run by root at 23:36 and rolled back'),
 'gate-v5': ('operational gate v5 PROPOSAL (f5077c21): one bounded window reset on a transient app transport error (after the 23:43 EyesOff '
             'URLError rollback). Source and tests only; NOT activated'),
 'lease-keeper': ('protected-lease keeper (b3c298c0): finite, journaled, app-funded renewals of the two original apps. Root runs it as a TEMPORARY '
                  'unit (4 h TTL to 03:53:51, at most 8 renewals per app); this is source, not its runtime state or journals'),
 'm-funding': ('operator C9 funding assessment (76ab248) and the standard EIP-7702 maintenance unsigned plan builder with read-only prepare and '
               'revm-processed test (fe7e1057). Source only; nothing signed or sent; no authorization change'),
 'current-docs5': ('R reconciled custody docs on 155a23f4 (cd4f51a3): temporary keeper TTL, control still unregistered, 00:00 fresh reads (committee '
                   '0x4774 epoch 1 t 1, book unset; fresh SNP quote PASS, attestation only). Not published; recovery NOT done'),
}
for k, v in NOTES.items():
    if k in sides: sides[k]['note'] = v
derivs = {}
for k, s_ in DERIVS.items():
    d = export(k, s_, exclude=s_['exclude'])
    assert not forbidden(d), k
    omitted = {}
    for c in d['commits']:
        c['originalTree'] = c['tree']; c['tree'] = derived_tree(s_['repo'], c['commit'], s_['exclude'])
        omitted[c['commit']] = [dict(zip(('mode', 'type', 'blob', 'bytes', 'path'), l.split(None, 4)))
                                for x in s_['exclude'] for l in git(s_['repo'], 'ls-tree', '-r', '-l', c['commit'], '--', x).splitlines()]
    d['originalHeadTree'] = d['headTree']; d['headTree'] = d['commits'][-1]['tree']
    d['omittedAtHead'] = [{**a, 'sha256': sha(git(s_['repo'], 'cat-file', 'blob', a['blob'], text=False))} for a in omitted[d['head']]]
    assert [a['path'] for a in d['omittedAtHead']] == ['evidence/original-baseline-20261023T213130Z.json'], d['omittedAtHead']
    d['excluded'] = list(s_['exclude'])
    d['label'] = ('SOURCE-ONLY DERIVATIVE: ' + NOTES[k] + '; the committed read-only production baseline evidence/original-baseline-20261023T213130Z.json '
                  'is omitted per root; blob and sha256 in omittedAtHead')
    d['omittedRecipe'] = 'restore the blob in omittedAtHead from the source repository at the head; with it the tree equals originalHeadTree'
    d['note'] = NOTES[k]
    derivs[k] = d
got = {k: v['headTree'][:8] for k, v in sides.items()} | {k: v['originalHeadTree'][:8] for k, v in derivs.items()}
assert got == TREES, ('head trees', got)
lit = {}
for q in out.rglob('*'):
    if q.is_file():
        bb = q.read_bytes(); n = (bb.count(OLD), bb.count(OLD.lower()))
        if any(n): lit[str(q.relative_to(out))] = n
        assert PKBLOCK not in bb, ('private-key block', q)
for name in FROZEN + ROOT_EVIDENCE:
    bb = (base / name).resolve().read_bytes(); n = (bb.count(OLD), bb.count(OLD.lower()))
    if any(n): lit['frozen:' + name] = n
    assert PKBLOCK not in bb and len(bb) < 5_000_000, name
    bb.decode('utf-8')
    assert sha(bb).startswith(PIN[name]) if name in PIN else True, (name, 'moved from its pinned bytes')
assert not lit, ('rewritten literal (either case) in export', lit)
frozen = {name: sha((base / name).resolve().read_bytes()) for name in FROZEN}
evidence = {name: sha((base / name).resolve().read_bytes()) for name in ROOT_EVIDENCE}
inventory = {'format': 'enclave-frozen-0022-export/v1', 'checkpointHeadAtExport': CHECKPOINT_HEAD,
    'batch': '0022 = the batch start 2026-10-24T00:21:55Z (date -u): an identifier, not a publication time',
    'label': ('SOURCE + EVIDENCE ONLY. Root boot-fee release metadata 3562faa1, gate v5 proposal f5077c21 (not activated), temporary lease keeper '
              'source b3c298c0, C9 standard 7702 maintenance assessment/plan builder fe7e1057 (unsigned), R current docs cd4f51a3; the public keeper '
              'receipt snapshot (00:01:40Z). Control recovery NOT done (rolled-back ed918e4b, unregistered); lease protection is temporary (TTL '
              '03:53:51); no secret lifecycle test; original committee unchanged and code-frozen. Root owns activation and signing.'),
    'sides': sides, 'derivatives': derivs, 'lowercaseRewrittenLiteral': lit, 'frozenSources': frozen, 'rootEvidence': evidence,
    'rootEvidenceNote': 'frozenSources include the exact snapshot of root\'s public keeper receipt (bb8ab3e2...; read and reviewed: public tx hashes, lease times, unit status, limitations only)',
    'evidenceVsSource': 'Committed logs, receipts, run outputs and RESULT files inside these repositories are EVIDENCE; the rest is source.',
    'notPreserved': ['the live repo commit 3055ee7 (not designated in this batch) and every later commit',
                     'keeper runtime state, intents, journals, raw signatures, key paths and private backups (never read)',
                     'M and D new WIP sources, untracked root files (ROOT-*, logs, evidence/root-*), uncommitted work',
                     'images, binaries, WASM, node_modules, keys, sealed state']}
(out / 'INVENTORY.json').write_text(json.dumps(inventory, indent=1) + '\n')
print(json.dumps({k: {'commits': len(v['commits']), 'files': len(v['changedFiles'])} for k, v in {**sides, **derivs}.items()}
                 | {'frozen': len(frozen), 'rootEvidence': len(evidence), 'inventorySha256': sha((out / 'INVENTORY.json').read_bytes())}))

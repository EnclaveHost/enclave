"""Export the frozen-2355 batch for the checkpoint, from Git OBJECTS only (never from mutable or dirty worktrees; ignored and untracked files
are never read, except the runtime receipts and outer docs root explicitly allowed). "2355" is the batch IDENTIFIER = its actual start,
2026-10-23T23:55:07Z (date -u). Exactly root's designated heads; the builder 979a9ef, the active lease keeper, funding and gate-v5 work are excluded.

* custody-live9   custody-v2-live-20261023 851f7579 (frozen-2329 custody-live8 head) -> 2b0c975b
* current-docs4   custody-v2-current-docs-20261023 967eeb96 (frozen-2329 current-docs3 head) -> 155a23f4
* boot-source3    custody-boot-registration-20261023/repo 9f6d37bd (frozen-2217 boot-source head) -> 5db2be3f: PATCH-ONLY, parent-anchored
                  (supervisor.js held back: rewritten literal; never the whole old tree)
* d-fee-kit       custody-boot-fee-activation-20261023 root -> 9d75f953 (derivative: committed old baseline evidence/ omitted)
plus root-allowed runtime receipts (result.json, gate.json, evidence/postrollback-public-health.json) and H outer docs (NORMAL-FEE-FIX.md,
FEE-AMEND-STATUS.txt), exact bytes, read and scanned.
"""
from pathlib import Path
import hashlib, json, os, re, shutil, subprocess, tempfile

root = Path(__file__).resolve().parents[3]
W = root / 'work'
base = W / 'resume-after-checkpoint-20261022'
sp = base / 'source-preservation'
out = sp / 'frozen-2355-export'
checkpoint = W / 'source-checkpoint-20261022/main-repo'
CHECKPOINT_HEAD = '48c524ae5bb8a7d9787d44d148cb2f624413bd05'
AUTHOR = 'SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'
OLD = bytes.fromhex('54696e666f696c')
PKBLOCK = bytes.fromhex('50524956415445204b45592d2d2d2d2d')
R = lambda repo, name, branch, b, head, commits, prov, **kw: {'repo': repo, 'name': name, 'branch': branch, 'base': b, 'head': head,
                                                              'commits': commits.split(), 'baseProvenance': prov, **kw}
ROOTC = 'root commit'
SIDES = {
    'custody-live9': R(W / 'custody-v2-live-20261023', 'custody-live9-2b0c975b', 'master', '851f75797b09b7dce8d7b256baedc1b74803f203',
                       '2b0c975b5b299cff4574099f8078ee3d8fce38b5', '2b0c975b', '851f7579 preserved in 48c524ae (frozen-2329 custody-live8 head)'),
    'current-docs4': R(W / 'custody-v2-current-docs-20261023', 'current-docs4-155a23f4', 'master', '967eeb96dfaf7df7ca2f9db334c9f3b8b3d743f2',
                       '155a23f450189d26eb045d2fb5f430d595250132', '155a23f4', '967eeb96 preserved in 48c524ae (frozen-2329 current-docs3 head)'),
}
BOOT = R(W / 'custody-boot-registration-20261023/repo', 'boot-source3-5db2be3f', 'boot-normal-fee', '9f6d37bd858ad44be1171b6415353910214c2fa5',
         '5db2be3f4d4bed2c543e1e181c976ca9e26aa410', '5db2be3f', '9f6d37bd preserved in 7ca36e11 (frozen-2217 boot-source, patch-only)')
DERIVS = {
    'd-fee-kit': R(W / 'custody-boot-fee-activation-20261023', 'd-fee-kit-9d75f953', 'main', None,
                   '9d75f953b463c56835934f5262a0aba914087ff3', '9d75f953', ROOTC, exclude=('evidence/',)),
}
FROZEN = ['source-preservation/RESULT-frozen-2329-checkpoint.md',
          'source-preservation/snapshots-2355/custody-v2-live-verification-20261023.snapshot-2355.md',
          '../custody-boot-registration-20261023/NORMAL-FEE-FIX.md', '../custody-boot-registration-20261023/FEE-AMEND-STATUS.txt']
ROOT_EVIDENCE = ['../custody-boot-fee-activation-20261023/result.json', '../custody-boot-fee-activation-20261023/gate.json',
                 '../custody-boot-fee-activation-20261023/evidence/postrollback-public-health.json']
PIN = {'source-preservation/snapshots-2355/custody-v2-live-verification-20261023.snapshot-2355.md': '6d1e3d31109f4c8a',
       '../custody-boot-registration-20261023/NORMAL-FEE-FIX.md': 'e6ad5ac38a7c4c05', '../custody-boot-registration-20261023/FEE-AMEND-STATUS.txt': '7b13c7ddfa2eef9f',
       '../custody-boot-fee-activation-20261023/result.json': '462acf11d21d96d6', '../custody-boot-fee-activation-20261023/gate.json': 'ee4007e1cd9b7043',
       '../custody-boot-fee-activation-20261023/evidence/postrollback-public-health.json': 'dce2cfde063e4d6f'}


import atexit
_ATTR = tempfile.NamedTemporaryFile('w', suffix='.attributes', delete=False); _ATTR.write('* diff=nofunc2355\n'); _ATTR.close(); atexit.register(os.unlink, _ATTR.name)
NOFUNC = ('-c', f'core.attributesFile={_ATTR.name}', '-c', 'diff.nofunc2355.xfuncname=^$')


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
TREES = {}
NOPE = ('.exe', '.bin', '.wasm', '.zip', '.tar', '.gz', '.dll', '.pdb', '.key', '.img', '.qcow2', '.raw', '.sealed', '.so', '.rlib', '.cwasm', 'vmlinuz', '.cpio')
def forbidden(side): return [f['path'] for f in side['changedFiles'] if f['path'].endswith(NOPE) or 'node_modules/' in f['path'] or 'raw' in Path(f['path']).name.lower()
                             or 'private' in f['path'] or Path(f['path']).name.startswith('ROOT-')]
assert not [p for s in sides.values() for p in forbidden(s)]
INV = 'checkpoints/decentralization-20261022/closeout-followup/files/source-preservation/frozen-{}-export/INVENTORY.json'
F2329 = json.loads(git(checkpoint, 'show', f'{CHECKPOINT_HEAD}:' + INV.format('2329')))
F2217 = json.loads(git(checkpoint, 'show', f'{CHECKPOINT_HEAD}:' + INV.format('2217')))
F2146 = json.loads(git(checkpoint, 'show', f'{CHECKPOINT_HEAD}:' + INV.format('2146')))
for k, want in (('custody-live9', 'custody-live8'), ('current-docs4', 'current-docs3')):
    assert sides[k]['base'] == F2329['sides'][want]['head'] and sides[k]['commits'][0]['parent'] == F2329['sides'][want]['head'], (k, 'base is not the pushed frozen-2329 head')
assert BOOT['base'] == F2217['sides']['boot-source']['head']
# ---- boot-source3: PATCH-ONLY, every base blob anchored to a pushed record ----------------------------------------------------
pushed_head_blob = {t['path']: t['headBlob'] for t in F2217['sides']['boot-source']['touched']}
for t in F2146['sides']['recipient-restore-repo']['commits'][-1]['touchedBlobs']:
    pushed_head_blob.setdefault(t['path'], t['blob'])
MR = BOOT['repo']; bs_dir = out / BOOT['name']
head = git(MR, 'rev-parse', BOOT['head'] + '^{commit}').strip(); assert head == BOOT['head']
rows = [dict(zip(('commit', 'parent', 'tree', 'author', 'committer', 'committedAt', 'subject'), l.split('\t')))
        for l in git(MR, 'log', '--reverse', '--first-parent', '--format=%H%x09%P%x09%T%x09%an <%ae>%x09%cn <%ce>%x09%cI%x09%s', f"{BOOT['base']}..{head}").splitlines()]
assert [r['commit'][:8] for r in rows] == BOOT['commits'] and rows[0]['parent'] == BOOT['base'] and all(r['author'] == AUTHOR == r['committer'] for r in rows)
assert subprocess.run(['git', '-C', str(MR), 'merge-base', '--is-ancestor', head, BOOT['branch']]).returncode == 0
patch = git(MR, *NOFUNC, 'format-patch', '--stdout', '--full-index', '--no-renames', '--no-signature', f"{BOOT['base']}..{head}", text=False)
patch.decode('utf-8'); assert b'GIT binary patch' not in patch and OLD not in patch and OLD.lower() not in patch and PKBLOCK not in patch
(bs_dir / 'patches').mkdir(parents=True); pf = bs_dir / 'patches' / f'0001-{head[:8]}.patch'; pf.write_bytes(patch)
with tempfile.TemporaryDirectory() as t:
    env = {**os.environ, 'GIT_INDEX_FILE': str(Path(t) / 'index')}
    run = lambda *a: subprocess.run(['git', '-C', str(MR), *a], env=env, check=True, capture_output=True, text=True).stdout
    run('read-tree', BOOT['base']); run('apply', '--cached', '--whitespace=nowarn', str(pf))
    assert run('write-tree').strip() == rows[-1]['tree'], 'patch does not reproduce 5db2be3f from 9f6d37bd'
touched, stored, base_files, held, anchors = [], [], [], [], {}
for line in git(MR, 'diff', '--name-status', '--no-renames', BOOT['base'], head).splitlines():
    st, p = line.split('\t'); assert st in ('M', 'A'), line
    hb = git(MR, 'rev-parse', f'{head}:{p}').strip(); hd = git(MR, 'cat-file', 'blob', hb, text=False)
    bb = git(MR, 'rev-parse', f"{BOOT['base']}:{p}").strip() if st == 'M' else None
    bd = git(MR, 'cat-file', 'blob', bb, text=False) if bb else b''
    mode = git(MR, 'ls-tree', head, '--', p).split()[0]
    lit = any(OLD in d or OLD.lower() in d for d in (bd, hd))
    if bb:
        assert pushed_head_blob.get(p) == bb, (p, 'base blob is not the pushed 2217/2146 record', pushed_head_blob.get(p), bb)
        anchors[p] = bb
    rec = {'path': p, 'status': st, 'mode': mode, 'baseBlob': bb, 'baseSha256': sha(bd) if bb else None, 'headBlob': hb, 'headSha256': sha(hd),
           'bytes': len(hd), 'containsRewrittenLiteral': lit}
    assert (f'index {bb}..{hb}' if bb else f'index 0000000000000000000000000000000000000000..{hb}').encode() in patch, (p, 'patch index line')
    touched.append(rec)
    if lit:
        held.append(p); continue
    if bb:
        t_ = bs_dir / 'base-files' / p; t_.parent.mkdir(parents=True, exist_ok=True); t_.write_bytes(bd)
        base_files.append({'path': p, 'mode': mode, 'blob': bb, 'file': str(t_.relative_to(out)), 'sha256': sha(bd)})
    t_ = bs_dir / 'files' / p; t_.parent.mkdir(parents=True, exist_ok=True); t_.write_bytes(hd)
    stored.append({'path': p, 'status': st, 'mode': mode, 'blob': hb, 'sha256': sha(hd), 'bytes': len(hd), 'baseBlob': bb})
assert held == ['supervisor.js'], held
sides['boot-source3'] = {'repo': str(MR.relative_to(root)), 'branch': BOOT['branch'], 'headReachableFromBranch': True, 'base': BOOT['base'],
    'baseProvenance': BOOT['baseProvenance'], 'head': head, 'headTree': rows[-1]['tree'], 'commits': rows, 'changedFiles': stored,
    'patches': [{'file': str(pf.relative_to(out)), 'sha256': sha(patch)}], 'baseFiles': base_files, 'patchOnly': True, 'touched': touched,
    'heldBackForRewrittenLiteral': held,
    'patchProvenance': {'exportTimeCheck': 'a throwaway index of the real parent 9f6d37bd + this patch == 5db2be3f tree (asserted at export)',
        'baseBlobAnchors': {p: {'blob': b_, 'pushedIn': 'frozen-2217 boot-source touched headBlob' if p in {t['path'] for t in F2217['sides']['boot-source']['touched']}
                                 else 'frozen-2146 recipient-restore-repo touchedBlobs head'} for p, b_ in anchors.items()},
        'why': 'supervisor.js (base and head) contains the provider name the 2026-10-21 rewrite removed: not published (no waiver); the patch is literal-free'}}
TREES['boot-source3'] = rows[-1]['tree'][:8]
NOTES = {
 'custody-live9': ('ROOT live records on 851f7579 (2b0c975b): app-funded renewals of 23:31, the approved sender price probe, and the verified '
                   'normal registration receipt (23:41) before the failed health gate. Read-only metadata; no logs or raw quotes'),
 'current-docs4': ('R reconciled custody docs on 967eeb96 (155a23f4): status matrix (source-tested inert vs SNP startup-only vs unexecuted '
                   'production lifecycle), the 23:36 attempt (registered and adopted, gate FAILED, rollback 23:43), payout is not accepted host '
                   'ownership. Not published; recovery NOT done'),
 'boot-source3': ('H explicit-fee boot source 5db2be3f on 9f6d37bd (7dd3acd delta + explicit operator fees + tests). PATCH-ONLY, parent-anchored; '
                  'supervisor.js held back (rewritten literal). Root ran it at 23:36 (bc731956): registration succeeded, gate FAILED, rolled back'),
 'd-fee-kit': ('D fourth activation kit for the boot FEE build (9d75f953): source, provenance and tests (49/16/89 PASS). Root ran it 23:36:51: '
               'gate FAILED, rollback 23:43:19. Root runtime files ignored and never read except the three root-allowed receipts'),
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
got = {k: v['headTree'][:8] for k, v in sides.items()}
print('trees', got | {k: v['originalHeadTree'][:8] for k, v in derivs.items()})
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
inventory = {'format': 'enclave-frozen-2355-export/v1', 'checkpointHeadAtExport': CHECKPOINT_HEAD,
    'batch': '2355 = the batch start 2026-10-23T23:55:07Z (date -u): an identifier, not a publication time',
    'label': ('SOURCE + EVIDENCE ONLY. ROOT live records 2b0c975b; R current docs 155a23f4 (status matrix; 23:36 attempt registered and adopted, '
              'gate FAILED, rollback 23:43); H explicit-fee source 5db2be3f (patch-only, parent-anchored) and its outer docs; D boot-fee kit '
              '9d75f953 (committed old baseline omitted) with its three root-allowed runtime receipts; the public live-verification output after '
              'its 23:54Z top-status correction. Control recovery NOT done; no lifecycle canary; no migration or old-copy deletion; the builder '
              '979a9ef, the lease keeper, funding and gate-v5 work are NOT included. Root owns activation and signing.'),
    'sides': sides, 'derivatives': derivs, 'lowercaseRewrittenLiteral': lit, 'frozenSources': frozen, 'rootEvidence': evidence,
    'rootEvidenceNote': ('rootEvidence = the D boot-fee kit runtime receipts root explicitly allowed (public ids/hashes/status only; read and scanned). '
                         'frozenSources include the H outer docs NORMAL-FEE-FIX.md / FEE-AMEND-STATUS.txt and the corrected public output (6d1e3d31); its '
                         'pre-correction bytes equal the stored 2329 snapshot 60408087 and are not stored again'),
    'evidenceVsSource': 'Committed logs, receipts, run outputs and RESULT files inside these repositories are EVIDENCE; the rest is source.',
    'notPreserved': ['the D kit committed old baseline evidence/original-baseline-20261023T213130Z.json (blob recorded)',
                     'every other ignored/untracked D kit file: private-backup, raw attestation, logs/root-*, ROOT-* files, other evidence, plan/admission/build files, review and progress files (never read)',
                     'supervisor.js of boot-source3 at base and head (rewritten literal): blobs and sha256 recorded, patch published',
                     'the builder 979a9ef (D adding public build metadata), the H lease keeper, M funding assessment, gate v5 and every later commit',
                     'images, binaries, WASM, node_modules, keys, signatures, sealed state, uncommitted WIP']}
(out / 'INVENTORY.json').write_text(json.dumps(inventory, indent=1) + '\n')
print(json.dumps({k: {'commits': len(v['commits']), 'files': len(v['changedFiles'])} for k, v in {**sides, **derivs}.items()}
                 | {'frozen': len(frozen), 'rootEvidence': len(evidence), 'inventorySha256': sha((out / 'INVENTORY.json').read_bytes())}))

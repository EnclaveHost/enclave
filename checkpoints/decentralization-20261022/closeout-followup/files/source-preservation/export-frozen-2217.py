"""Export the frozen-2217 batch for the checkpoint, from Git OBJECTS only (never from mutable or dirty worktrees; ignored and untracked
files are never read). "2217" is the batch IDENTIFIER = its actual start, 2026-10-23T22:17:46Z (date -u); not a publication time.
Exactly the heads root designated (custody-code-admission-20261023/ROOT-PRESERVE-2215.txt); later worker/root WIP is excluded.

* custody-live6         custody-v2-live-20261023 1535fcf0 (frozen-2146 custody-live5 head) -> ed284731
* recipient-restore2    custody-recipient-restore-20261023 b03be02d (frozen-2146 head) -> e02b3bd4, 8f72453b
* boot-source           custody-boot-registration-20261023/repo a6b1378c (frozen-2146 recipient-restore-repo head) -> 9f6d37bd:
                        PATCH-ONLY (its parent tree, and supervisor.js itself, carry the rewritten literal; base supervisor.js is
                        pinned by sha256 to production /app/supervisor.js in the pushed deabf8f90 inventory)
* recipient-activation2 custody-recipient-activation-20261023 2d407753 (frozen-2146 head) -> cb7fa858, c83f2b39, 48cc74bf
* boot-activation       custody-boot-activation-20261023 root -> fa76e9bb, 86c5fee8 (derivative: committed runtime evidence/ omitted)
* proof-app2            custody-proof-app-20261023 e84a1afd (frozen-2146 head) -> ac33146d, ad81dd59 (no WASM/component binary)
* current-docs          custody-v2-current-docs-20261023 root -> dd9cc622, 42015b1e, 9d58a8b2, dfca5f05, a257c0e0
"""
from pathlib import Path
import hashlib, json, os, re, shutil, subprocess, tempfile

root = Path(__file__).resolve().parents[3]
W = root / 'work'
base = W / 'resume-after-checkpoint-20261022'
sp = base / 'source-preservation'
out = sp / 'frozen-2217-export'
checkpoint = W / 'source-checkpoint-20261022/main-repo'
CHECKPOINT_HEAD = 'dfb4b55e627ebd95b647abebf09627296f099862'
AUTHOR = 'SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'
OLD = bytes.fromhex('54696e666f696c')            # the former provider name (2026-10-21 rewrite), from hex
PKBLOCK = bytes.fromhex('50524956415445204b45592d2d2d2d2d')
R = lambda repo, name, branch, b, head, commits, prov, **kw: {'repo': repo, 'name': name, 'branch': branch, 'base': b, 'head': head,
                                                              'commits': commits.split(), 'baseProvenance': prov, **kw}
ROOTC = 'root commit'
SIDES = {
    'custody-live6': R(W / 'custody-v2-live-20261023', 'custody-live6-ed284731', 'master', '1535fcf0a3845c4ed625a0cd1095595963352f6f',
                       'ed2847318caa6a6ab729332a6c271ecad43f0684', 'ed284731', '1535fcf0 preserved in dfb4b55e (frozen-2146 custody-live5 head)'),
    'recipient-restore2': R(W / 'custody-recipient-restore-20261023', 'recipient-restore2-8f72453b', 'main', 'b03be02d7d050dd4883e29e011c454942aa790ee',
                            '8f72453be3b702605b99a01621bd80aeb5211cfb', 'e02b3bd4 8f72453b', 'b03be02d preserved in dfb4b55e (frozen-2146 recipient-restore head)'),
    'recipient-activation2': R(W / 'custody-recipient-activation-20261023', 'recipient-activation2-48cc74bf', 'main', '2d4077530caa03228deac1abda3de8cb03d9550b',
                               '48cc74bfb8ea2b6d13617b82c5c154789c884cd0', 'cb7fa858 c83f2b39 48cc74bf', '2d407753 preserved in dfb4b55e (frozen-2146 recipient-activation head)'),
    'proof-app2': R(W / 'custody-proof-app-20261023', 'proof-app2-ad81dd59', 'master', 'e84a1afd10e19cf8ec4ca48d3d8e389fe8beaa73',
                    'ad81dd59f1559dfea74629d4133d75b168047c55', 'ac33146d ad81dd59', 'e84a1afd preserved in dfb4b55e (frozen-2146 proof-app head)'),
    'current-docs': R(W / 'custody-v2-current-docs-20261023', 'current-docs-a257c0e0', 'master', None,
                      'a257c0e04bb8fe4d1ae14064758c411ed92c1f5b', 'dd9cc622 42015b1e 9d58a8b2 dfca5f05 a257c0e0', ROOTC),
}
BOOT = R(W / 'custody-boot-registration-20261023/repo', 'boot-source-9f6d37bd', 'boot-registration-adopt', 'a6b1378cdf430217025987d90c040d0e25a9993d',
         '9f6d37bd858ad44be1171b6415353910214c2fa5', '9f6d37bd', 'a6b1378c preserved in dfb4b55e (frozen-2146 recipient-restore-repo, touched files)')
DERIVS = {
    # root: "source/provenance/tests only; OMIT runtime root logs/private/evidence/approval/admission/plan ignore content". Ignored root
    # runtime files are never read (Git objects only). The one COMMITTED runtime record, evidence/original-baseline-20261023T213130Z.json (a
    # read-only production unit/config baseline taken at 21:31:30Z), is omitted; its blob and sha256 are recorded (omittedAtHead)
    'boot-activation': R(W / 'custody-boot-activation-20261023', 'boot-activation-86c5fee8', 'main', None,
                         '86c5fee82c98278e4d1c9446a63f903ab6a131e2', 'fa76e9bb 86c5fee8', ROOTC, exclude=('evidence/',)),
}
FROZEN = ['source-preservation/RESULT-frozen-2146-checkpoint.md']
ROOT_EVIDENCE = []


import atexit
_ATTR = tempfile.NamedTemporaryFile('w', suffix='.attributes', delete=False); _ATTR.write('* diff=nofunc2217\n'); _ATTR.close(); atexit.register(os.unlink, _ATTR.name)
NOFUNC = ('-c', f'core.attributesFile={_ATTR.name}', '-c', 'diff.nofunc2217.xfuncname=^$')


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
TREES = {'custody-live6': 'b84ef921', 'recipient-restore2': '1eb98032', 'recipient-activation2': '9d278ae1', 'proof-app2': 'd2aadd32',
         'current-docs': '89f863af', 'boot-activation': 'e4b4b85c', 'boot-source': '59f0a46d'}
assert {k: v['headTree'][:8] for k, v in sides.items()} == {k: TREES[k] for k in sides}, 'head trees'
NOPE = ('.exe', '.bin', '.wasm', '.zip', '.tar', '.gz', '.dll', '.pdb', '.key', '.img', '.qcow2', '.raw', '.sealed', '.so', '.rlib', '.cwasm')
def forbidden(side): return [f['path'] for f in side['changedFiles'] if f['path'].endswith(NOPE) or 'node_modules/' in f['path'] or 'raw' in Path(f['path']).name.lower()]
assert not [p for s in sides.values() for p in forbidden(s)]
# ---- continuity with the PUSHED frozen-2146 inventory -----------------------------------------------------------------------
INV = 'checkpoints/decentralization-20261022/closeout-followup/files/source-preservation/frozen-{}-export/INVENTORY.json'
F2146 = json.loads(git(checkpoint, 'show', f'{CHECKPOINT_HEAD}:' + INV.format('2146')))
for k, want in (('custody-live6', 'custody-live5'), ('recipient-restore2', 'recipient-restore'), ('recipient-activation2', 'recipient-activation'),
                ('proof-app2', 'proof-app')):
    assert sides[k]['base'] == F2146['sides'][want]['head'] and sides[k]['commits'][0]['parent'] == F2146['sides'][want]['head'], (k, 'base is not the pushed frozen-2146 head')
assert BOOT['base'] == F2146['sides']['recipient-restore-repo']['head']
# ---- boot-source: PATCH-ONLY side -----------------------------------------------------------------------------------------------
MR = BOOT['repo']; bs_dir = out / BOOT['name']
head = git(MR, 'rev-parse', BOOT['head'] + '^{commit}').strip(); assert head == BOOT['head']
rows = [dict(zip(('commit', 'parent', 'tree', 'author', 'committer', 'committedAt', 'subject'), l.split('\t')))
        for l in git(MR, 'log', '--reverse', '--first-parent', '--format=%H%x09%P%x09%T%x09%an <%ae>%x09%cn <%ce>%x09%cI%x09%s', f"{BOOT['base']}..{head}").splitlines()]
assert [r['commit'][:8] for r in rows] == BOOT['commits'] and rows[0]['parent'] == BOOT['base'] and all(r['author'] == AUTHOR == r['committer'] for r in rows)
assert subprocess.run(['git', '-C', str(MR), 'merge-base', '--is-ancestor', head, BOOT['branch']]).returncode == 0
patch = git(MR, *NOFUNC, 'format-patch', '--stdout', '--full-index', '--no-renames', '--no-signature', f"{BOOT['base']}..{head}", text=False)
patch.decode('utf-8'); assert b'GIT binary patch' not in patch and OLD not in patch and OLD.lower() not in patch and PKBLOCK not in patch
(bs_dir / 'patches').mkdir(parents=True); pf = bs_dir / 'patches' / f'0001-{head[:8]}.patch'; pf.write_bytes(patch)
# export-time exactness against the REAL parent: a throwaway index of a6b1378c + the patch == 9f6d37bd's tree
with tempfile.TemporaryDirectory() as t:
    env = {**os.environ, 'GIT_INDEX_FILE': str(Path(t) / 'index')}
    run = lambda *a: subprocess.run(['git', '-C', str(MR), *a], env=env, check=True, capture_output=True, text=True).stdout
    run('read-tree', BOOT['base']); run('apply', '--cached', '--whitespace=nowarn', str(pf))
    assert run('write-tree').strip() == rows[-1]['tree'], 'patch does not reproduce 9f6d37bd from a6b1378c'
touched, stored, base_files, held = [], [], [], []
for line in git(MR, 'diff', '--name-status', '--no-renames', BOOT['base'], head).splitlines():
    st, p = line.split('\t'); assert st == 'M', line
    bb, hb = git(MR, 'rev-parse', f"{BOOT['base']}:{p}").strip(), git(MR, 'rev-parse', f'{head}:{p}').strip()
    bd, hd = git(MR, 'cat-file', 'blob', bb, text=False), git(MR, 'cat-file', 'blob', hb, text=False)
    mode = git(MR, 'ls-tree', head, '--', p).split()[0]
    lit = any(OLD in d or OLD.lower() in d for d in (bd, hd))
    rec = {'path': p, 'mode': mode, 'baseBlob': bb, 'baseSha256': sha(bd), 'headBlob': hb, 'headSha256': sha(hd), 'bytes': len(hd),
           'containsRewrittenLiteral': lit}
    assert f'index {bb}..{hb}'.encode() in patch, (p, 'patch index line does not name the recorded blobs')
    touched.append(rec)
    if lit:
        held.append(p); continue
    for kind, d, blob in (('base-files', bd, bb), ('files', hd, hb)):
        t_ = bs_dir / kind / p; t_.parent.mkdir(parents=True, exist_ok=True); t_.write_bytes(d)
    base_files.append({'path': p, 'mode': mode, 'blob': bb, 'file': str((bs_dir / 'base-files' / p).relative_to(out)), 'sha256': sha(bd)})
    stored.append({'path': p, 'status': 'M', 'mode': mode, 'blob': hb, 'sha256': sha(hd), 'bytes': len(hd), 'baseBlob': bb})
INVP = 'checkpoints/decentralization-20261022/closeout-followup/files/source-preservation/frozen-2100-export/recipient-provenance-8b0c4da2/held-out/out/dist-leasegas-deabf8f90/initramfs-inventory.json'
prod = {m['path']: m['sha256'] for m in json.loads(git(checkpoint, 'show', f'{CHECKPOINT_HEAD}:{INVP}'))['members']}
sup = next(x for x in touched if x['path'] == 'supervisor.js')
assert prod['/app/supervisor.js'] == sup['baseSha256'], 'base supervisor.js is not production deabf8f90 /app/supervisor.js'
assert held == ['supervisor.js'], held
sides['boot-source'] = {'repo': str(MR.relative_to(root)), 'branch': BOOT['branch'], 'headReachableFromBranch': True, 'base': BOOT['base'],
    'baseProvenance': BOOT['baseProvenance'], 'head': head, 'headTree': rows[-1]['tree'], 'commits': rows, 'changedFiles': stored,
    'patches': [{'file': str(pf.relative_to(out)), 'sha256': sha(patch)}], 'baseFiles': base_files, 'patchOnly': True, 'touched': touched,
    'heldBackForRewrittenLiteral': held,
    'patchProvenance': {'exportTimeCheck': 'a throwaway index of the real parent a6b1378c + this patch == 9f6d37bd tree (asserted at export)',
        'supervisorBasePinnedTo': {'pushedInventory': INVP, 'member': '/app/supervisor.js', 'sha256': prod['/app/supervisor.js']},
        'why': ('supervisor.js (base and head) contains the provider name the 2026-10-21 rewrite removed, so neither is published (no literal '
                'waiver); the patch hunks are literal-free and published exactly; the test file is published at base and head')}}
assert sides['boot-source']['headTree'][:8] == TREES['boot-source']
NOTES = {
 'custody-live6': ('ROOT live records on 1535fcf0 (ed284731): protected app renewal intents/results (incl. the 22:11 batch), public boot-state '
                   'and guest-health reads, fresh-quote verdict metadata, renewal/listing/boot-state probes. Read-only metadata; no logs or raw quotes'),
 'recipient-restore2': ('approval-gated bounded build template (e02b3bd4) and the approved boot-registration build record (8f72453b): H 9f6d37bd on '
                        'a6b1378c built twice -> measurement 08d1f838, its patch and inventories, refusal tests. Staged only; not activated'),
 'boot-source': ('H source 9f6d37bd on a6b1378c: supervisor adopts an existing exact registration at boot instead of a full re-register, with '
                 'tests. PATCH-ONLY: exact patch + test file; supervisor.js held back (rewritten literal), pinned by blob and sha256'),
 'recipient-activation2': ('legacy-control proof-key verification (cb7fa858), exact recovery target (c83f2b39), review of the boot-registration '
                           'recovery with a strict verdict checker (48cc74bf). Source/test only'),
 'proof-app2': ('custody-canary-proof publication preparation: read-only catalog publication request (ac33146d) and the bounded paced '
                'publish-prepare tool with catalog/oracle fixtures, tests and evidence (ad81dd59). No WASM or component binary; nothing published'),
 'current-docs': ('R reconciled custody v2 documentation for root review: CURRENT-STATE (incident PROVISIONAL, refreshed to root\'s 22:14Z '
                  'journal), TEST-MATRIX, ROLLBACK, SIGNING-AUTHORITY, SOURCES, doc patches against checkpoint dfb4b55e and main 68b82926. '
                  'Not published; no rollout claimed'),
 'boot-activation': ('second image-only activation adaptation for the approved boot-registration image (fa76e9bb) and boot funding with '
                     'canonical block agreement (86c5fee8): source, provenance and tests. Root\'s runtime files are ignored and never read'),
}
for k, v in NOTES.items():
    if k in sides: sides[k]['note'] = v
derivs = {}
for k, s_ in DERIVS.items():
    d = export(k, s_, exclude=s_['exclude'])
    assert not forbidden(d), k
    assert d['headTree'][:8] == TREES[k], (k, 'original head tree')
    omitted = {}
    for c in d['commits']:
        c['originalTree'] = c['tree']; c['tree'] = derived_tree(s_['repo'], c['commit'], s_['exclude'])
        omitted[c['commit']] = [dict(zip(('mode', 'type', 'blob', 'bytes', 'path'), l.split(None, 4)))
                                for x in s_['exclude'] for l in git(s_['repo'], 'ls-tree', '-r', '-l', c['commit'], '--', x).splitlines()]
    d['originalHeadTree'] = d['headTree']; d['headTree'] = d['commits'][-1]['tree']
    d['omittedAtHead'] = [{**a, 'sha256': sha(git(s_['repo'], 'cat-file', 'blob', a['blob'], text=False))} for a in omitted[d['head']]]
    assert [a['path'] for a in d['omittedAtHead']] == ['evidence/original-baseline-20261023T213130Z.json'], d['omittedAtHead']
    d['excluded'] = list(s_['exclude'])
    d['label'] = ('SOURCE-ONLY DERIVATIVE: ' + NOTES[k] + '; the committed runtime record evidence/original-baseline-20261023T213130Z.json '
                  '(a read-only production baseline) is omitted per root (source/provenance/tests only); blob and sha256 in omittedAtHead')
    d['omittedRecipe'] = 'restore the blob in omittedAtHead from the source repository at the head; with it the tree equals originalHeadTree'
    d['note'] = NOTES[k]
    derivs[k] = d
# ---- literal / private-key guard ----------------------------------------------------------------------------------------------
lit = {}
for q in out.rglob('*'):
    if q.is_file():
        bb = q.read_bytes(); n = (bb.count(OLD), bb.count(OLD.lower()))
        if any(n): lit[str(q.relative_to(out))] = n
        assert PKBLOCK not in bb, ('private-key block', q)
for name in FROZEN + ROOT_EVIDENCE:
    bb = (base / name).resolve().read_bytes(); n = (bb.count(OLD), bb.count(OLD.lower()))
    if any(n): lit['frozen:' + name] = n
assert not lit, ('rewritten literal (either case) in export', lit)
frozen = {name: sha((base / name).resolve().read_bytes()) for name in FROZEN}
evidence = {name: sha((base / name).resolve().read_bytes()) for name in ROOT_EVIDENCE}
inventory = {'format': 'enclave-frozen-2217-export/v1', 'checkpointHeadAtExport': CHECKPOINT_HEAD,
    'batch': '2217 = the batch start 2026-10-23T22:17:46Z (date -u): an identifier, not a publication time',
    'label': ('SOURCE + EVIDENCE ONLY. ROOT live records ed284731; recipient restore build record 8f72453b (H 08d1f838 staged, NOT activated); '
              'boot-registration source 9f6d37bd (patch-only); recipient activation review 48cc74bf; boot activation kit 86c5fee8 (source/tests; '
              'the cutover was STOPPED before mutation, a new boot-pricing fix is pending and not included); proof app publish prep ad81dd59 '
              '(nothing published); R current docs a257c0e0 (not published). metal0 control recovery is IN PROGRESS (still the old image, '
              'unregistered); no new custody committee, policy, v2 book entry or dashboard publication. Root owns activation and signing.'),
    'sides': sides, 'derivatives': derivs, 'lowercaseRewrittenLiteral': lit, 'frozenSources': frozen, 'rootEvidence': evidence,
    'rootEvidenceNote': 'no root outputs file and no journal snapshot in this batch; the frozen-2146 receipt is stored',
    'evidenceVsSource': 'Committed logs, receipts, run outputs and RESULT files inside these repositories are EVIDENCE; the rest is source.',
    'notPreserved': ['ignored/untracked files in every repo: root runtime logs, private, evidence, approval, admission and plan files in '
                     'custody-boot-activation (its .gitignore), images, binaries, WASM/components, CARs, build outputs, node_modules, raw quotes, '
                     'sealed state, keys, task prompts and progress/err files, uncommitted WIP',
                     'the ongoing H boot-pricing fix, the new wallet repository and the new build template (root: skip; WIP)',
                     'supervisor.js of boot-source at base and head (rewritten literal): blobs and sha256 recorded, patch published',
                     'commits after these heads and every worktree change']}
(out / 'INVENTORY.json').write_text(json.dumps(inventory, indent=1) + '\n')
print(json.dumps({k: {'commits': len(v['commits']), 'files': len(v['changedFiles'])} for k, v in {**sides, **derivs}.items()}
                 | {'frozen': len(frozen), 'inventorySha256': sha((out / 'INVENTORY.json').read_bytes())}))

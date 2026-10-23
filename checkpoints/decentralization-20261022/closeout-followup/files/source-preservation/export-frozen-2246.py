"""Export the frozen-2246 batch for the checkpoint, from Git OBJECTS only (never from mutable or dirty worktrees; ignored and untracked
files are never read). "2246" is the batch IDENTIFIER = its actual start, 2026-10-23T22:46:00Z (date -u); not a publication time.
Exactly the heads root designated (custody-v2-current-docs-20261023/ROOT-PRESERVE-2245.txt); the new D activation kit, the rejected W
helper and every later commit are excluded.

* custody-live7      custody-v2-live-20261023 ed284731 (frozen-2217 custody-live6 head) -> d64f0443, b4e1f14
* boot-source2       custody-boot-registration-20261023/repo 9f6d37bd (frozen-2217 boot-source head) -> 7dd3acd0: PATCH-ONLY, anchored to the
                     pushed 2217/2146 blob records (supervisor.js held back: rewritten literal)
* boot-price-release custody-boot-price-release-20261023 root -> a340762b, 88b70dbe (88b70dbe = root-granted public build metadata)
* canary-wallet      custody-canary-wallet-20261023 root -> f161ceb, b5e4613 (journals/ ignored, never read; no WASM)
* current-docs2      custody-v2-current-docs-20261023 a257c0e0 (frozen-2217 current-docs head) -> ac4d9da, c571a3f, 8fda71f2, 1b3c2611
"""
from pathlib import Path
import hashlib, json, os, re, shutil, subprocess, tempfile

root = Path(__file__).resolve().parents[3]
W = root / 'work'
base = W / 'resume-after-checkpoint-20261022'
sp = base / 'source-preservation'
out = sp / 'frozen-2246-export'
checkpoint = W / 'source-checkpoint-20261022/main-repo'
CHECKPOINT_HEAD = '7ca36e11f65c76feaf6c26405b5a27a7457f113d'
AUTHOR = 'SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'
OLD = bytes.fromhex('54696e666f696c')            # the former provider name (2026-10-21 rewrite), from hex
PKBLOCK = bytes.fromhex('50524956415445204b45592d2d2d2d2d')
R = lambda repo, name, branch, b, head, commits, prov, **kw: {'repo': repo, 'name': name, 'branch': branch, 'base': b, 'head': head,
                                                              'commits': commits.split(), 'baseProvenance': prov, **kw}
ROOTC = 'root commit'
SIDES = {
    'custody-live7': R(W / 'custody-v2-live-20261023', 'custody-live7-b4e1f14', 'master', 'ed2847318caa6a6ab729332a6c271ecad43f0684',
                       'b4e1f14', 'd64f0443 b4e1f14', 'ed284731 preserved in 7ca36e11 (frozen-2217 custody-live6 head)'),
    'boot-price-release': R(W / 'custody-boot-price-release-20261023', 'boot-price-release-88b70dbe', 'main', None,
                            '88b70dbefdff5c2433317da6d184b5e09e363e78', 'a340762b 88b70dbe', ROOTC),
    'canary-wallet': R(W / 'custody-canary-wallet-20261023', 'canary-wallet-b5e4613', 'master', None, 'b5e4613', 'f161ceb b5e4613', ROOTC),
    'current-docs2': R(W / 'custody-v2-current-docs-20261023', 'current-docs2-1b3c2611', 'master', 'a257c0e04bb8fe4d1ae14064758c411ed92c1f5b',
                       '1b3c26117d2ca4bb6488ea51f9180c6004abe2bd', 'ac4d9da c571a3f 8fda71f2 1b3c2611', 'a257c0e0 preserved in 7ca36e11 (frozen-2217 current-docs head)'),
}
BOOT = R(W / 'custody-boot-registration-20261023/repo', 'boot-source2-7dd3acd0', 'boot-gpu-price', '9f6d37bd858ad44be1171b6415353910214c2fa5',
         '7dd3acd061af765cdcd9ba21b9744f2f2c6bdf5b', '7dd3acd0', '9f6d37bd preserved in 7ca36e11 (frozen-2217 boot-source, patch-only)')
DERIVS = {}
FROZEN = ['source-preservation/RESULT-frozen-2217-checkpoint.md', 'source-preservation/snapshots-2246/custody-v2-live-verification-20261023.snapshot-2246.md']
ROOT_EVIDENCE = []


import atexit
_ATTR = tempfile.NamedTemporaryFile('w', suffix='.attributes', delete=False); _ATTR.write('* diff=nofunc2246\n'); _ATTR.close(); atexit.register(os.unlink, _ATTR.name)
NOFUNC = ('-c', f'core.attributesFile={_ATTR.name}', '-c', 'diff.nofunc2246.xfuncname=^$')


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
sides = {}
for k, s_ in SIDES.items():   # short heads resolved to the full commit once (frozen at the batch start)
    s_['head'] = git(s_['repo'], 'rev-parse', s_['head'] + '^{commit}').strip()
    sides[k] = export(k, s_, exclude=s_.get('exclude', ()))
FULL = {'custody-live7': 'b4e1f14', 'canary-wallet': 'b5e4613'}
for k, p in FULL.items(): assert sides[k]['head'].startswith(p), k
TREES = {}
for k, v in sides.items(): TREES[k] = v['headTree'][:8]
NOPE = ('.exe', '.bin', '.wasm', '.zip', '.tar', '.gz', '.dll', '.pdb', '.key', '.img', '.qcow2', '.raw', '.sealed', '.so', '.rlib', '.cwasm', 'vmlinuz', '.cpio')
def forbidden(side): return [f['path'] for f in side['changedFiles'] if f['path'].endswith(NOPE) or 'node_modules/' in f['path'] or 'raw' in Path(f['path']).name.lower()
                             or f['path'].startswith('journals/')]
assert not [p for s in sides.values() for p in forbidden(s)]
# root grant check: 88b70dbe adds EXACTLY the public build metadata, no script changed, no image binary
grant = sorted(f['path'] for f in sides['boot-price-release']['changedFiles'] if f['path'].startswith(('stage/', 'APPROVED-COMMIT.txt', 'logs/root-build-price')))
assert grant == sorted(['APPROVED-COMMIT.txt', 'stage/build-record.json', 'stage/INVENTORY.sha256', 'stage/7dd3acd06-on-9f6d37bd.patch',
    'logs/root-build-price.out', 'logs/root-build-price.guard.log', 'logs/root-build-price.rc', 'stage/dist-leasegas-7dd3acd06/MEASUREMENT',
    'stage/dist-leasegas-7dd3acd06/manifest.json', 'stage/dist-leasegas-7dd3acd06/cmdline']), grant
g88 = git(sides['boot-price-release']['repo'] if False else SIDES['boot-price-release']['repo'], 'diff', '--name-only', 'a340762bb88f9c50e992146cb876f4052cb2255a', '88b70dbefdff5c2433317da6d184b5e09e363e78').split()
assert sorted(g88) == grant, ('88b70dbe touches only the granted files', g88)
# ---- continuity with the PUSHED frozen-2217 inventory -----------------------------------------------------------------------
INV = 'checkpoints/decentralization-20261022/closeout-followup/files/source-preservation/frozen-{}-export/INVENTORY.json'
F2217 = json.loads(git(checkpoint, 'show', f'{CHECKPOINT_HEAD}:' + INV.format('2217')))
F2146 = json.loads(git(checkpoint, 'show', f'{CHECKPOINT_HEAD}:' + INV.format('2146')))
for k, want in (('custody-live7', 'custody-live6'), ('current-docs2', 'current-docs')):
    assert sides[k]['base'] == F2217['sides'][want]['head'] and sides[k]['commits'][0]['parent'] == F2217['sides'][want]['head'], (k, 'base is not the pushed frozen-2217 head')
assert BOOT['base'] == F2217['sides']['boot-source']['head']
# ---- boot-source2: PATCH-ONLY, every base blob anchored to a pushed record ----------------------------------------------------
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
    assert run('write-tree').strip() == rows[-1]['tree'], 'patch does not reproduce 7dd3acd0 from 9f6d37bd'
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
sides['boot-source2'] = {'repo': str(MR.relative_to(root)), 'branch': BOOT['branch'], 'headReachableFromBranch': True, 'base': BOOT['base'],
    'baseProvenance': BOOT['baseProvenance'], 'head': head, 'headTree': rows[-1]['tree'], 'commits': rows, 'changedFiles': stored,
    'patches': [{'file': str(pf.relative_to(out)), 'sha256': sha(patch)}], 'baseFiles': base_files, 'patchOnly': True, 'touched': touched,
    'heldBackForRewrittenLiteral': held,
    'patchProvenance': {'exportTimeCheck': 'a throwaway index of the real parent 9f6d37bd + this patch == 7dd3acd0 tree (asserted at export)',
        'baseBlobAnchors': {p: {'blob': b_, 'pushedIn': 'frozen-2217 boot-source touched headBlob' if p in {t['path'] for t in F2217['sides']['boot-source']['touched']}
                                 else 'frozen-2146 recipient-restore-repo touchedBlobs head'} for p, b_ in anchors.items()},
        'why': 'supervisor.js (base and head) contains the provider name the 2026-10-21 rewrite removed: not published (no waiver); the patch is literal-free'}}
TREES['boot-source2'] = rows[-1]['tree'][:8]
NOTES = {
 'custody-live7': ('ROOT live records on ed284731: second EyesOff app-funded renewal and public app health (d64f0443); current custody state '
                   'known-state 22:20 and the 22:39 protected renewals with their probe (b4e1f14). Read-only metadata; no logs or raw quotes'),
 'boot-source2': ('H source 7dd3acd0 on 9f6d37bd: a shielded card\'s GPU price stays pending until discovered, the known price is kept and '
                  'setProofKey proceeds; a failed registry read never registers; tests. PATCH-ONLY (supervisor.js held back, rewritten literal); '
                  'root-approved candidate, built twice (b007d471), NOT activated'),
 'boot-price-release': ('approval-gated bounded build template for the child of 9f6d37bd (a340762b) and the root-granted public metadata of '
                        'root\'s 7dd3acd build (88b70dbe): approval, build record, inventory, patch, root build log, MEASUREMENT, manifest, '
                        'cmdline. The image binaries are NOT committed (sha256 in INVENTORY.sha256). Candidate only, not activated'),
 'canary-wallet': ('canary app upload + catalog publish administrator MetaMask handoff (f161ceb) and the upload-stage fix (b5e4613): source and '
                   'tests only; journals (live server) ignored and never read; no WASM; nothing signed or sent'),
 'current-docs2': ('R reconciled custody docs on a257c0e0: rollback corrections against the actual vault semantics (ac4d9da), patch 0003 and '
                   'regenerated cumulative diffs (c571a3f), measured timestamps (8fda71f2), root 22:45Z status (1b3c2611; candidate NOT '
                   'activated, recovery NOT done). Not published; no rollout claimed'),
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
inventory = {'format': 'enclave-frozen-2246-export/v1', 'checkpointHeadAtExport': CHECKPOINT_HEAD,
    'batch': '2246 = the batch start 2026-10-23T22:46:00Z (date -u): an identifier, not a publication time',
    'label': ('SOURCE + EVIDENCE ONLY. ROOT live records b4e1f14; boot-pricing source 7dd3acd0 (patch-only) and its build-release template + '
              'root-granted public build metadata 88b70dbe (candidate b007d471, built twice, NOT activated); canary-wallet handoff b5e4613 '
              '(source/tests; nothing signed); R current docs 1b3c2611; the 22:42 snapshot of root\'s public live-verification output. At 22:45 '
              'the metal0 control was still on the old image and unregistered; the new D activation kit is NOT included. No committee, admin '
              'contract, book or dashboard change; no secret lifecycle test. Root owns activation and signing.'),
    'sides': sides, 'derivatives': derivs, 'lowercaseRewrittenLiteral': lit, 'frozenSources': frozen, 'rootEvidence': evidence,
    'rootEvidenceNote': 'the living outputs file is captured as the dated snapshot snapshots-2246 (22:42:35Z, sha256 d57763d1...); its earlier stored bytes stay unchanged',
    'evidenceVsSource': 'Committed logs, receipts, run outputs and RESULT files inside these repositories are EVIDENCE; the rest is source.',
    'notPreserved': ['ignored/untracked files in every repo: canary-wallet journals (live server), boot-price-release stage image binaries '
                     '(initramfs.cpio.gz, vmlinuz; sha256 in INVENTORY.sha256), WASM/components, node_modules, raw quotes, keys, sealed state, '
                     'private files and signatures, task/progress/err files, uncommitted WIP',
                     'the new D activation kit (custody-boot-price-activation-20261023; under review, not frozen) and the rejected W helper',
                     'supervisor.js of boot-source2 at base and head (rewritten literal): blobs and sha256 recorded, patch published',
                     'commits after these heads and every worktree change']}
(out / 'INVENTORY.json').write_text(json.dumps(inventory, indent=1) + '\n')
print(json.dumps({k: {'commits': len(v['commits']), 'files': len(v['changedFiles'])} for k, v in {**sides, **derivs}.items()}
                 | {'frozen': len(frozen), 'inventorySha256': sha((out / 'INVENTORY.json').read_bytes())}))

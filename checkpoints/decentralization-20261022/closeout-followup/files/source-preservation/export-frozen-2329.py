"""Export the frozen-2329 batch for the checkpoint, from Git OBJECTS only (never from mutable or dirty worktrees; ignored and untracked
files are never read, except the two runtime receipts root explicitly allowed). "2329" is the batch IDENTIFIER = its actual start,
2026-10-23T23:29:30Z (date -u); not a publication time. Exactly root's designated heads; the active H (5db2be3f) and new D builds are excluded.

* custody-live8   custody-v2-live-20261023 b4e1f14 (frozen-2246 custody-live7 head) -> 851f7579
* current-docs3   custody-v2-current-docs-20261023 1b3c2611 (frozen-2246 current-docs2 head) -> ac48ded, 50f05862, 967eeb96
* d-kit (deriv.)  custody-boot-price-activation-20261023 root -> 8bbd0a74 (the old FAILED kit; committed baseline evidence omitted)
plus, as root runtime receipts (root-reviewed: public ids/hashes/status only): the kit's result.json and evidence/postrollback-health.json
"""
from pathlib import Path
import hashlib, json, os, re, shutil, subprocess, tempfile

root = Path(__file__).resolve().parents[3]
W = root / 'work'
base = W / 'resume-after-checkpoint-20261022'
sp = base / 'source-preservation'
out = sp / 'frozen-2329-export'
checkpoint = W / 'source-checkpoint-20261022/main-repo'
CHECKPOINT_HEAD = 'ef1baaa1b136208e2e86e5f978b7095617fdb501'
AUTHOR = 'SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'
OLD = bytes.fromhex('54696e666f696c')
PKBLOCK = bytes.fromhex('50524956415445204b45592d2d2d2d2d')
R = lambda repo, name, branch, b, head, commits, prov, **kw: {'repo': repo, 'name': name, 'branch': branch, 'base': b, 'head': head,
                                                              'commits': commits.split(), 'baseProvenance': prov, **kw}
ROOTC = 'root commit'
SIDES = {
    'custody-live8': R(W / 'custody-v2-live-20261023', 'custody-live8-851f7579', 'master', 'b4e1f14f2ce65799978c18ce201f3a5ef674569c',
                       '851f75797b09b7dce8d7b256baedc1b74803f203', '851f7579', 'b4e1f14 preserved in ef1baaa1 (frozen-2246 custody-live7 head)'),
    'current-docs3': R(W / 'custody-v2-current-docs-20261023', 'current-docs3-967eeb96', 'master', '1b3c26117d2ca4bb6488ea51f9180c6004abe2bd',
                       '967eeb96dfaf7df7ca2f9db334c9f3b8b3d743f2', 'ac48ded 50f05862 967eeb96', '1b3c2611 preserved in ef1baaa1 (frozen-2246 current-docs2 head)'),
}
DERIVS = {
    # root: omit the old baseline file (a read-only production unit/config baseline, also omitted from boot-activation in 2217); source only
    # plus already committed public metadata. Its blob and sha256 are recorded (omittedAtHead)
    'd-kit': R(W / 'custody-boot-price-activation-20261023', 'd-kit-8bbd0a74', 'main', None,
               '8bbd0a745641f8f66d835c75eb3a8e3feef3eb47', '8bbd0a74', ROOTC, exclude=('evidence/',)),
}
FROZEN = ['source-preservation/RESULT-frozen-2246-checkpoint.md',
          'source-preservation/snapshots-2329/custody-v2-live-verification-20261023.pre-correction-2329.md',
          'source-preservation/snapshots-2329/custody-v2-live-verification-20261023.snapshot-2329.md']
# root explicitly allowed these two failed-runtime receipts (public ids, hashes, status only); exact bytes, read and scanned
ROOT_EVIDENCE = ['../custody-boot-price-activation-20261023/result.json', '../custody-boot-price-activation-20261023/evidence/postrollback-health.json']
PIN = {'source-preservation/snapshots-2329/custody-v2-live-verification-20261023.pre-correction-2329.md': '4d613dc8230e1a8e',
       'source-preservation/snapshots-2329/custody-v2-live-verification-20261023.snapshot-2329.md': '604080876baf9118',
       '../custody-boot-price-activation-20261023/result.json': '511808455bac7ef4',
       '../custody-boot-price-activation-20261023/evidence/postrollback-health.json': '5f131bf1687044bd'}


import atexit
_ATTR = tempfile.NamedTemporaryFile('w', suffix='.attributes', delete=False); _ATTR.write('* diff=nofunc2329\n'); _ATTR.close(); atexit.register(os.unlink, _ATTR.name)
NOFUNC = ('-c', f'core.attributesFile={_ATTR.name}', '-c', 'diff.nofunc2329.xfuncname=^$')


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
TREES = {'custody-live8': 'c8abbfae', 'current-docs3': '60f2fe7e', 'd-kit': '9a5a3b2c'}
NOPE = ('.exe', '.bin', '.wasm', '.zip', '.tar', '.gz', '.dll', '.pdb', '.key', '.img', '.qcow2', '.raw', '.sealed', '.so', '.rlib', '.cwasm', 'vmlinuz', '.cpio')
def forbidden(side): return [f['path'] for f in side['changedFiles'] if f['path'].endswith(NOPE) or 'node_modules/' in f['path'] or 'raw' in Path(f['path']).name.lower()
                             or 'private' in f['path'] or Path(f['path']).name.startswith('ROOT-')]
assert not [p for s in sides.values() for p in forbidden(s)]
INV = 'checkpoints/decentralization-20261022/closeout-followup/files/source-preservation/frozen-{}-export/INVENTORY.json'
F2246 = json.loads(git(checkpoint, 'show', f'{CHECKPOINT_HEAD}:' + INV.format('2246')))
for k, want in (('custody-live8', 'custody-live7'), ('current-docs3', 'current-docs2')):
    assert sides[k]['base'] == F2246['sides'][want]['head'] and sides[k]['commits'][0]['parent'] == F2246['sides'][want]['head'], (k, 'base is not the pushed frozen-2246 head')
NOTES = {
 'custody-live8': ('ROOT live records on b4e1f14 (851f7579): protected app renewals of 23:06, the read-only UNSIGNED fee-path probe of 23:19:59 '
                   '(signing and broadcast disabled), the canary top-up preflight, and their probes. Read-only metadata; no logs or raw quotes'),
 'current-docs3': ('R reconciled custody docs on 1b3c2611: recipient-binding conclusions (direct SNP quote gates confidentiality; registry proofKey '
                   'not an input; relay pointer not chain-verified, so no value-integrity claim) with patch 0004 (ac48ded, 50f05862); the 23:10 '
                   'FAILED control recovery and the 23:15 rollback, the fee cause NOT confirmed (967eeb96). Not published; recovery NOT done'),
 'd-kit': ('D third image-only activation kit for the boot GPU-price build (8bbd0a74): source, provenance and tests; root-final-tests PASS. Root ran it at '
           '23:10 and it FAILED (no adoption; rolled back 23:15:29). Root runtime files ignored and never read, except the two receipts root allowed'),
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
inventory = {'format': 'enclave-frozen-2329-export/v1', 'checkpointHeadAtExport': CHECKPOINT_HEAD,
    'batch': '2329 = the batch start 2026-10-23T23:29:30Z (date -u): an identifier, not a publication time',
    'label': ('SOURCE + EVIDENCE ONLY. ROOT live records 851f7579 (renewals, unsigned fee probe, top-up preflight); R current docs 967eeb96 (recipient '
              'binding; 23:10 FAILED control recovery, 23:15 rollback; fee cause NOT confirmed); the old FAILED D activation kit 8bbd0a74 with its '
              'two root-allowed runtime receipts (result.json, evidence/postrollback-health.json); the public live-verification output before and '
              'after its 23:29Z top-status correction (health stated only as last observed 23:16). Control recovery NOT done; the explicit-fee H '
              '5db2be3f build (running 23:28) and new D builds are NOT included. Root owns activation and signing.'),
    'sides': sides, 'derivatives': derivs, 'lowercaseRewrittenLiteral': lit, 'frozenSources': frozen, 'rootEvidence': evidence,
    'rootEvidenceNote': ('rootEvidence = the two runtime receipts root explicitly allowed (public ids/hashes/status only; read and scanned); the '
                         'outputs file is captured as two dated snapshots (pre-correction 4d613dc8 and corrected 60408087); its earlier stored bytes stay unchanged'),
    'evidenceVsSource': 'Committed logs, receipts, run outputs and RESULT files inside these repositories are EVIDENCE; the rest is source.',
    'notPreserved': ['the D kit committed baseline evidence/original-baseline-20261023T213130Z.json (blob recorded)',
                     'every other ignored/untracked file of the D kit: private-backup, raw attestation, logs/root-*, ROOT-* files, other evidence, '
                     'review and progress files (never read)', 'the active explicit-fee H 5db2be3f/9b82acc8 sources and new D builds',
                     'images, binaries, WASM, node_modules, keys, sealed state, uncommitted WIP, commits after these heads']}
(out / 'INVENTORY.json').write_text(json.dumps(inventory, indent=1) + '\n')
print(json.dumps({k: {'commits': len(v['commits']), 'files': len(v['changedFiles'])} for k, v in {**sides, **derivs}.items()}
                 | {'frozen': len(frozen), 'rootEvidence': len(evidence), 'inventorySha256': sha((out / 'INVENTORY.json').read_bytes())}))

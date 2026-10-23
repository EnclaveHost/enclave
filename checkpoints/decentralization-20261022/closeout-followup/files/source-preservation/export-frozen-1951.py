"""Export the frozen-1951 batch for the checkpoint, from Git OBJECTS only (never from mutable or dirty worktrees; ignored files are
never read). "1951" is the batch IDENTIFIER = its actual start, 2026-10-23T19:51Z (date -u); it is not a publication time. The CURRENT
committed heads root designated (root's message; ROOT-CONTINUE-LATEST 19:50Z); later M/R/root live-probe WIP is excluded.

* cpu-activation  cpu-quota-activation-20261023 root -> 3451c90, 785f77a (ROOT production CPU activation + recovery/TLS evidence)
* sched-manager   cpu-root-scheduler-quota-20261023/repo ea6717d2 (frozen-1726 cpu-enforce head) -> ab2ed9a2, 2cea9ead, 1bda7b79
* sched-guest     cpu-root-scheduler-quota-20261023/guest root -> f7b6ff55 ... f6d5fbed (isolation monitor exact-quota guest source)
* durability2     custody-v2-durability-20261023/repo 415483ff (frozen-1852 m-durability head) -> 3ccd4333, 0a6b108e, c95dcd3a, a5eae96c;
                  415483ff's tree is not in pushed material (frozen-1852: touched files only), so TOUCHED-FILE reproduction again
* custody-release custody-v2-release-20261023 root -> 44bf8f4 (corrected custodian e012 reproducible build + quote-only SNP canary)
* dashboard       custody-v2-dashboard-20261023/repo ff13ebe0 (frozen-1639 e-gen head) -> 2cf89ae2 ... 4acad4a7
* custody-live2   custody-v2-live-20261023 a90f8339 (frozen-1852 custody-live head) -> 70019fdf
* root-native2    coupled-cpu-enforcement-20261023/root-validation 8afbf879 (frozen-1852 root-cpu-quota head) -> e859355e
"""
from pathlib import Path
import hashlib, json, os, shutil, subprocess, tempfile

root = Path(__file__).resolve().parents[3]
W = root / 'work'
base = W / 'resume-after-checkpoint-20261022'
sp = base / 'source-preservation'
out = sp / 'frozen-1951-export'
checkpoint = W / 'source-checkpoint-20261022/main-repo'
CHECKPOINT_HEAD = '45bf6552f07a71cf7968e9b5bc48df8f5047d028'
AUTHOR = 'SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'
# OLD = the former provider name the 2026-10-21 repository rewrite replaced by 'Cloud Provider'; built from hex so this tool
# itself does not carry the literal it guards against
OLD = bytes.fromhex('54696e666f696c')
R = lambda repo, name, branch, b, head, commits, prov, **kw: {'repo': repo, 'name': name, 'branch': branch, 'base': b, 'head': head,
                                                              'commits': commits.split(), 'baseProvenance': prov, **kw}
ROOTC = 'root commit (ROOT repo)'
SQ = W / 'cpu-root-scheduler-quota-20261023'
SIDES = {
    'cpu-activation': R(W / 'cpu-quota-activation-20261023', 'cpu-activation-785f77af', 'master', None,
                        '785f77af9b9d128f0d913d7708137be8996f1c2d', '3451c90 785f77a', ROOTC),
    'sched-manager': R(SQ / 'repo', 'sched-manager-1bda7b79', 'cpu-quota-manager', 'ea6717d2725b8acd1b19837cdc6355421a94972d',
                       '1bda7b79c021f87359191538c91c45b246dde8fe', 'ab2ed9a2 2cea9ead 1bda7b79', 'ea6717d2 preserved in 45bf6552 (frozen-1726 cpu-enforce head)'),
    'durability2': R(W / 'custody-v2-durability-20261023/repo', 'durability2-a5eae96c', 'root-custody-rollout-closure',
                     '415483ff9784c38a88b273363a7efd0c227b95ce', 'a5eae96cdaa9f916266c9ee101908e14e75ad085', '3ccd4333 0a6b108e c95dcd3a a5eae96c',
                     '415483ff = frozen-1852 m-durability head, itself touched-file-only (base c635fd68 not publishable): TOUCHED-FILE reproduction',
                     # frozen-1951-export-1 gitleaks generic-api-key: the V2 vault's quoted source-file name followed by its quoted contract name
                     exclude=('test/helpers/original-vault-rig.mjs',)),
    'custody-release': R(W / 'custody-v2-release-20261023', 'custody-release-44bf8f4f', 'master', None,
                         '44bf8f4fb0b07ff8cbe7dc5cbf94819cc4377f6b', '44bf8f4f', ROOTC),
    'dashboard': R(W / 'custody-v2-dashboard-20261023/repo', 'dashboard-4acad4a7', 'custody-v2-dashboard', 'ff13ebe089f3c18a064892269c55ddca2b4409e9',
                   '4acad4a7a3d6858eae27c6c8573836f48395d9de', '2cf89ae2 5843da8c da56c238 d171bce4 5b2a0092 4acad4a7',
                   'ff13ebe0 preserved in 45bf6552 (frozen-1639 e-gen head)'),
    'custody-live2': R(W / 'custody-v2-live-20261023', 'custody-live2-70019fdf', 'master', 'a90f8339e7225e185393a646a879feaf4853c5b1',
                       '70019fdf9c7c4628cd852af7ac6ebae55843a610', '70019fdf', 'a90f8339 preserved in 45bf6552 (frozen-1852 custody-live head)'),
    'root-native2': R(W / 'coupled-cpu-enforcement-20261023/root-validation', 'root-native2-e859355e', 'master',
                      '8afbf879ae3960e1b958dad09ce0f331799f002c', 'e859355e65223d2210abf8d02ebd7567c8777968', 'e859355e',
                      '8afbf879 preserved in 45bf6552 (frozen-1852 root-cpu-quota head)'),
}
# frozen-1951-export-1 gitleaks generic-api-key: a local QEMU/KVM fixture log carrying "launcherKey" = the launcher's PUBLIC report
# verification key (32 bytes, base64; hvlab-accept.mjs judges reports with it) - omitted, not allowlisted
DERIVS = {'sched-guest': R(SQ / 'guest', 'sched-guest-f6d5fbed', 'cpu-quota-guest', None, 'f6d5fbedfdbac37f69717cda0b1ab510d2abf2ad',
                           'f7b6ff55 3dbbf835 216c3807 f6d5fbed', 'root commit (guest source repo: isolation/{contract,m2,m3} as at c85e0c5); SOURCE-ONLY DERIVATIVE',
                           exclude=('isolation/m3/hv-accept-check-2026-09-25.txt',))}
FROZEN = ['source-preservation/' + n for n in ('RESULT-frozen-1852-checkpoint.md', 'snapshots-1951/ROOT-CONTINUE-LATEST.snapshot-1951.txt')]
ROOT_EVIDENCE = ['../../outputs/decentralization-audit/' + n for n in ('nucbox-coupled-shares-production-20261023.json',
                                                                      'custody-v2-corrected-image-hardware-20261023.json')]


import atexit
_ATTR = tempfile.NamedTemporaryFile('w', suffix='.attributes', delete=False); _ATTR.write('* diff=nofunc1951\n'); _ATTR.close(); atexit.register(os.unlink, _ATTR.name)
NOFUNC = ('-c', f'core.attributesFile={_ATTR.name}', '-c', 'diff.nofunc1951.xfuncname=^$')


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
TREES = {'cpu-activation': 'd8d44a53', 'sched-manager': '5aa32ffb', 'durability2': 'd8afe7ff',
         'custody-release': 'afec64f0', 'dashboard': 'cfaa8d49', 'custody-live2': 'bb19b19a', 'root-native2': '3b445521'}
assert {k: v['headTree'][:8] for k, v in sides.items()} == TREES, 'head trees'
# no committed executable/archive/wasm/key anywhere (ignored binaries, raw quotes, sealed state, node_modules are never read)
assert not [f['path'] for s in sides.values() for f in s['changedFiles']
            if f['path'].endswith(('.exe', '.bin', '.wasm', '.zip', '.tar', '.gz', '.dll', '.pdb', '.key')) or 'node_modules/' in f['path'] or 'raw' in Path(f['path']).name.lower()]
# ---- durability2: touched-file reproduction (base 415483ff = frozen-1852 head, itself touched-file-only) -------------------
m, MR = sides['durability2'], SIDES['durability2']['repo']
touched = sorted({f['path'] for f in m['changedFiles']})
bf = out / SIDES['durability2']['name'] / 'base-files'
m['baseFiles'] = []
for p in touched:
    ls = git(MR, 'ls-tree', m['base'], '--', p).split()
    if not ls: continue
    data = git(MR, 'cat-file', 'blob', ls[2], text=False); data.decode('utf-8'); assert OLD not in data and OLD.lower() not in data, p
    (bf / p).parent.mkdir(parents=True, exist_ok=True); (bf / p).write_bytes(data)
    m['baseFiles'].append({'path': p, 'mode': ls[0], 'blob': ls[2], 'file': str((bf / p).relative_to(out)), 'sha256': sha(data)})
for c in m['commits']:   # a list of {path, blob}: a "secret-custody-v2.md": "<blob>" mapping line trips gitleaks generic-api-key (export-1)
    c['touchedBlobs'] = [{'path': p, 'blob': (git(MR, 'ls-tree', c['commit'], '--', p).split() or [None, None, None])[2]} for p in touched]
m['omittedAtHead'] = [{**dict(zip(('mode', 'type', 'blob', 'bytes', 'path'), l.split(None, 4))), 'sha256': sha(git(MR, 'cat-file', 'blob', l.split()[2], text=False))}
                      for x in SIDES['durability2']['exclude'] for l in git(MR, 'ls-tree', '-r', '-l', m['head'], '--', x).splitlines()]
m['excluded'] = list(SIDES['durability2']['exclude'])
m['omittedRecipe'] = ('test/helpers/original-vault-rig.mjs (new in 0a6b108e; blob in omittedAtHead) is omitted: its contract identifiers trip gitleaks '
                      'generic-api-key. It is excluded from the patches and the touched-path check; restore from M\'s repository at a5eae96c')
m['baseTreeNotReproduced'] = {'base': m['base'], 'baseTree': git(MR, 'rev-parse', m['base'] + '^{tree}').strip(),
    'why': 'continues frozen-1852 m-durability, whose base c635fd68 (pre-rewrite custody-release repo-b) is not publishable; full trees not claimed',
    'verified': "base-files/ + this side's patches reproduce every touched path's blob at every commit (verify-frozen-1951-export.py)"}
F1852 = json.loads((sp / 'frozen-1852-export/INVENTORY.json').read_text())
prior = {b['path']: b['blob'] for b in F1852['sides']['m-durability']['baseFiles']}
last = F1852['sides']['m-durability']['commits'][-1]['touchedBlobs']
assert m['commits'][0]['parent'] == F1852['sides']['m-durability']['head']
assert all(next(b['blob'] for b in m['baseFiles'] if b['path'] == p) == blob for p, blob in last.items() if blob and p in touched), 'base files != frozen-1852 head blobs'
NOTES = {
 'cpu-activation': ('ROOT production CPU activation: guarded exact-share activation (3451c90) and full NucBox app recovery with verified TLS (785f77a): '
                    'all 9 apps running exact coupled shares, strict CA/hostname HTTPS 200 on all 18 advertised routes (19:41Z, per root). Tracked text only; '
                    'the staged runtime/launcher binaries and ignored logs are not captured'),
 'sched-manager': ('B manager source on ea6717d2: every purchased CPU share confined by its exact guest quota (ab2ed9a2), manager test (2cea9ead), admit the '
                   'tested exact-share guest image without removing existing ones (1bda7b79); the exact 5 manager files root activated come from ab2ed9a2'),
 'sched-guest': ('B guest source repo (isolation/{contract,m2,m3} as at c85e0c5, root f7b6ff55) -> f6d5fbed: an explicit CPU allocation is the purchased share '
                 'exactly, below one processor too (root final image c1619eec built from f6d5, monitor-only). Committed public CA root / chain PEMs are '
                 'certificates, not keys. The built image is not captured'),
 'durability2': ('custody v2 durability through root-custody-rollout-closure: 3ccd4333 concurrent-write safety, 0a6b108e e2e on the original book-bound vault, '
                 'c95dcd3a genesis survives a failed/ambiguous submission (image e012 built from it), a5eae96c root startup fail-closed / launcher '
                 'original-vault identity / direct owner-read fixes. SOURCE ONLY: a5eae96c is NOT built, quoted or activated; it supersedes e012 for activation'),
 'custody-release': ('ROOT corrected custodian e012 (from c95dcd3a): two byte-identical reproducible builds and a genuine SNP QUOTE-ONLY hardware canary '
                     '(19:31Z; no registry/submitter key, no committee, no genesis, not activated). Superseded for activation by a5eae96c. Ignored canary '
                     'run directories, logs and custodian outputs are not captured'),
 'dashboard': ('R custody v2 dashboard on ff13ebe0: browser entry + vendor builder, committed browser bundle site/vendor/custody-v2.js built from 5843da8c, '
               'Secrets-panel owner flow, Node + real-browser tests, docs. Source/test only; not deployed'),
 'custody-live2': ('ROOT live custody configuration read on a90f8339: sealed-state retention, relay public config, DNS/provider policy inventory. Read-only; '
                   'no secrets/sealed state/private config read or captured; existing single-seat bootstrap unchanged (NOT decentralized)'),
 'root-native2': ('ROOT root-validation on 8afbf879: exact guest CPU quotas verified with sustained native workloads (after the 8afbf879 Hyper-V cap '
                  'counterexample). Text only; ignored binaries not captured'),
}
for k, v in NOTES.items():
    if k in sides: sides[k]['note'] = v
derivs = {}
for k, s in DERIVS.items():
    d = export(k, s, exclude=s['exclude'])
    omitted = {}
    for c in d['commits']:
        c['originalTree'] = c['tree']; c['tree'] = derived_tree(s['repo'], c['commit'], s['exclude'], s.get('hold'))
        omitted[c['commit']] = [dict(zip(('mode', 'type', 'blob', 'bytes', 'path'), l.split(None, 4)))
                                for x in s['exclude'] for l in git(s['repo'], 'ls-tree', '-r', '-l', c['commit'], '--', x).splitlines()]
    d['originalHeadTree'] = d['headTree']; d['headTree'] = d['commits'][-1]['tree']
    d['omittedAtHead'] = [{**a, 'sha256': sha(git(s['repo'], 'cat-file', 'blob', a['blob'], text=False))} for a in omitted[d['head']]]
    d['excluded'] = list(s['exclude'])
    derivs[k] = d
g = derivs['sched-guest']
assert g['originalHeadTree'] == 'b424a5c4b0fc9ed504c450d6887533debe1c5ca4', 'B guest head tree'
g['label'] = ('SOURCE-ONLY DERIVATIVE: ' + NOTES['sched-guest'] + '; minus isolation/m3/hv-accept-check-2026-09-25.txt (a local QEMU/KVM '
              'fixture log whose launcherKey - the launcher\'s PUBLIC report verification key - trips gitleaks generic-api-key)')
g['omittedRecipe'] = 'restore the fixture log from the guest repository at f6d5fbed (or c85e0c592, where it was committed); blob in omittedAtHead'
# ---- literal guard ----------------------------------------------------------------------------------------------------------
lit = {}
for q in out.rglob('*'):
    if q.is_file():
        bb = q.read_bytes(); n = (bb.count(OLD), bb.count(OLD.lower()))
        if any(n): lit[str(q.relative_to(out))] = n
for name in FROZEN + ROOT_EVIDENCE:
    bb = (base / name).resolve().read_bytes(); n = (bb.count(OLD), bb.count(OLD.lower()))
    if any(n): lit['frozen:' + name] = n
assert not lit, ('rewritten literal (either case) in export', lit)
frozen = {name: sha((base / name).resolve().read_bytes()) for name in FROZEN}
evidence = {name: sha((base / name).resolve().read_bytes()) for name in ROOT_EVIDENCE}
inventory = {'format': 'enclave-frozen-1951-export/v1', 'checkpointHeadAtExport': CHECKPOINT_HEAD,
    'batch': '1951 = the batch start 2026-10-23T19:51Z (date -u): an identifier, not a publication time',
    'label': ('SOURCE + EVIDENCE ONLY. ROOT CPU production activation (all 9 apps, exact coupled shares, 18/18 TLS per root) with B manager/guest source; '
              'custody v2: durability through a5eae96c (source only, not built/activated), root corrected-image release e012 (quote-only hardware '
              'canary; superseded for activation by a5eae96c; not activated), R dashboard (source/test), root live config reads. Existing custody is the '
              'original single-seat bootstrap, NOT decentralized custody.'),
    'sides': sides, 'derivatives': derivs, 'lowercaseRewrittenLiteral': lit, 'frozenSources': frozen, 'rootEvidence': evidence,
    'snapshotsUnchangedSince1852': ['ROOT-PENDING-LATEST.txt', 'effective-goal-requirements.txt'],
    'evidenceVsSource': 'Committed logs, receipts, run outputs and RESULT files inside these repositories are EVIDENCE; the rest is source.',
    'notPreserved': ['ignored/untracked files in every repo: binaries (staged runtime .bin, launcher .exe, custodian images), node_modules, raw quotes, '
                     'sealed state, private config, canary run directories and logs',
                     'commits after these heads and every worktree change: M/R resumed work, root live probes (custody-v2-live untracked book-plan etc.)',
                     'outer non-repo files of these work directories']}
(out / 'INVENTORY.json').write_text(json.dumps(inventory, indent=1) + '\n')
print(json.dumps({k: {'commits': len(v['commits']), 'files': len(v['changedFiles'])} for k, v in {**sides, **derivs}.items()}
                 | {'frozen': len(frozen), 'rootEvidence': len(evidence), 'inventorySha256': sha((out / 'INVENTORY.json').read_bytes())}))

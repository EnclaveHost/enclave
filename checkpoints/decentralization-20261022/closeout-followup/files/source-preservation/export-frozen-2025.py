"""Export the frozen-2025 batch for the checkpoint, from Git OBJECTS only (never from mutable or dirty worktrees; ignored files are
never read). "2025" is the batch IDENTIFIER = its actual start, 2026-10-23T20:25Z (date -u); it is not a publication time, nor a year.
The committed heads root designated (ROOT-PRESERVE-TASK.txt); later worker/root WIP and every untracked file are excluded.

* durability3       custody-v2-durability-20261023/repo a5eae96c (frozen-1951 durability2 head) -> ab589bf8 (TOUCHED-FILE mode again)
* custody-release2  custody-v2-release-20261023 44bf8f4f (frozen-1951 custody-release head) -> da6e3496, 23f7e51a (r2)
* dashboard2        custody-v2-dashboard-20261023/repo 4acad4a7 (frozen-1951 dashboard head) -> 10cea38b ... e24a47fb
* custody-live3     custody-v2-live-20261023 70019fdf (frozen-1951 custody-live2 head) -> 574fdc97, 3fd6e8ff
* wallet-handoff    custody-wallet-handoff-20261023 root -> 7b49cd99 (its plain-transfer fund stage REFUSES the 7702-delegated operator: not usable)
* operator-proposal custody-operator-proposal-20261023 root -> f2a7b81e, 1ac9ad2c
* snp-harness       custody-snp-recovery-harness-20261023 root -> e9b9709a, 7c4844a1 (corrected-image SNP startup/outage recovery evidence)
* direct-route      custody-v2-direct-route-20261023 root -> fc7bff94
"""
from pathlib import Path
import hashlib, json, os, shutil, subprocess, tempfile

root = Path(__file__).resolve().parents[3]
W = root / 'work'
base = W / 'resume-after-checkpoint-20261022'
sp = base / 'source-preservation'
out = sp / 'frozen-2025-export'
checkpoint = W / 'source-checkpoint-20261022/main-repo'
CHECKPOINT_HEAD = 'dc551728a71e29adb8eda127f4607395a4d97b66'
AUTHOR = 'SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'
# OLD = the former provider name the 2026-10-21 repository rewrite replaced by 'Cloud Provider'; built from hex so this tool
# itself does not carry the literal it guards against
OLD = bytes.fromhex('54696e666f696c')
R = lambda repo, name, branch, b, head, commits, prov, **kw: {'repo': repo, 'name': name, 'branch': branch, 'base': b, 'head': head,
                                                              'commits': commits.split(), 'baseProvenance': prov, **kw}
ROOTC = 'root commit'
SIDES = {
    'durability3': R(W / 'custody-v2-durability-20261023/repo', 'durability3-ab589bf8', 'root-custody-rollout-closure',
                     'a5eae96cdaa9f916266c9ee101908e14e75ad085', 'ab589bf80b669c9671b53573d489b6c6c45779ea', 'ab589bf8',
                     'a5eae96c = frozen-1951 durability2 head, itself touched-file-only (base not publishable): TOUCHED-FILE reproduction'),
    'custody-release2': R(W / 'custody-v2-release-20261023', 'custody-release2-23f7e51a', 'master', '44bf8f4fb0b07ff8cbe7dc5cbf94819cc4377f6b',
                          '23f7e51aab5c6016035e73a1058ba33e64c0dcba', 'da6e3496 23f7e51a', '44bf8f4f preserved in dc551728 (frozen-1951 custody-release head)'),
    'dashboard2': R(W / 'custody-v2-dashboard-20261023/repo', 'dashboard2-e24a47fb', 'custody-v2-dashboard', '4acad4a7a3d6858eae27c6c8573836f48395d9de',
                    'e24a47fb22399b220d25f4e3b8d544083b13fdb0', '10cea38b 7f0320a4 dd6cf94a e24a47fb', '4acad4a7 preserved in dc551728 (frozen-1951 dashboard head)'),
    'custody-live3': R(W / 'custody-v2-live-20261023', 'custody-live3-3fd6e8ff', 'master', '70019fdf9c7c4628cd852af7ac6ebae55843a610',
                       '3fd6e8ff99dbda1a261d11be00beea3e6549cbe9', '574fdc97 3fd6e8ff', '70019fdf preserved in dc551728 (frozen-1951 custody-live2 head)'),
    'wallet-handoff': R(W / 'custody-wallet-handoff-20261023', 'wallet-handoff-7b49cd99', 'main', None,
                        '7b49cd995414d3769a9b0c3cae8e189d6bbb87c7', '7b49cd99', ROOTC),
    'operator-proposal': R(W / 'custody-operator-proposal-20261023', 'operator-proposal-1ac9ad2c', 'master', None,
                           '1ac9ad2cb798d16cc060adb6a02f0272cef9976b', 'f2a7b81e 1ac9ad2c', ROOTC),
    'snp-harness': R(W / 'custody-snp-recovery-harness-20261023', 'snp-harness-7c4844a1', 'main', None,
                     '7c4844a17fecf870d4790ca8620cfd8c1e60780c', 'e9b9709a 7c4844a1', ROOTC),
    'direct-route': R(W / 'custody-v2-direct-route-20261023', 'direct-route-fc7bff94', 'master', None,
                      'fc7bff941260a0b482b079aba3ec674cd5661acc', 'fc7bff94', ROOTC),
}
# derivative sides (gitleaks findings reviewed in frozen-2025-export-N; filled in only from ACTUAL findings, never pre-emptively)
DERIVS = {}
# custody-v2-live-verification-20261023.md is already in the manifest (earlier bytes 23c9aeba...): its CURRENT bytes are a dated snapshot
FROZEN = ['source-preservation/' + n for n in ('RESULT-frozen-1951-checkpoint.md', 'snapshots-2025/ROOT-CONTINUE-LATEST.snapshot-2025.txt',
                                               'snapshots-2025/custody-v2-live-verification-20261023.snapshot-2025.md')]
ROOT_EVIDENCE = ['../../outputs/decentralization-audit/' + n for n in ('custody-v2-snp-startup-recovery-20261023.json',)]


import atexit
_ATTR = tempfile.NamedTemporaryFile('w', suffix='.attributes', delete=False); _ATTR.write('* diff=nofunc2025\n'); _ATTR.close(); atexit.register(os.unlink, _ATTR.name)
NOFUNC = ('-c', f'core.attributesFile={_ATTR.name}', '-c', 'diff.nofunc2025.xfuncname=^$')


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
TREES = {'durability3': '0a1f82e1', 'custody-release2': '62adfd03', 'dashboard2': '413e76ec', 'custody-live3': 'b7857703',
         'wallet-handoff': 'da50e554', 'operator-proposal': 'e6a98714', 'snp-harness': '0fb8af49', 'direct-route': '474c9922'}
assert {k: v['headTree'][:8] for k, v in sides.items()} == {k: TREES[k] for k in sides}, 'head trees'
# no committed executable/archive/wasm/key anywhere (ignored binaries, raw quotes, sealed state, node_modules are never read)
NOPE = ('.exe', '.bin', '.wasm', '.zip', '.tar', '.gz', '.dll', '.pdb', '.key', '.img', '.qcow2', '.raw', '.sealed')
def forbidden(side): return [f['path'] for f in side['changedFiles'] if f['path'].endswith(NOPE) or 'node_modules/' in f['path'] or 'raw' in Path(f['path']).name.lower()]
assert not [p for s in sides.values() for p in forbidden(s)]
# ---- durability3: touched-file reproduction (base a5eae96c = frozen-1951 durability2 head, itself touched-file-only) -------------
m, MR = sides['durability3'], SIDES['durability3']['repo']
touched = sorted({f['path'] for f in m['changedFiles']})
bf = out / SIDES['durability3']['name'] / 'base-files'
m['baseFiles'] = []
for p in touched:
    ls = git(MR, 'ls-tree', m['base'], '--', p).split()
    if not ls: continue
    data = git(MR, 'cat-file', 'blob', ls[2], text=False); data.decode('utf-8'); assert OLD not in data and OLD.lower() not in data, p
    (bf / p).parent.mkdir(parents=True, exist_ok=True); (bf / p).write_bytes(data)
    m['baseFiles'].append({'path': p, 'mode': ls[0], 'blob': ls[2], 'file': str((bf / p).relative_to(out)), 'sha256': sha(data)})
for c in m['commits']:   # a list of {path, blob} (frozen-1951: a path-keyed mapping trips gitleaks generic-api-key)
    c['touchedBlobs'] = [{'path': p, 'blob': (git(MR, 'ls-tree', c['commit'], '--', p).split() or [None, None, None])[2]} for p in touched]
m['baseTreeNotReproduced'] = {'base': m['base'], 'baseTree': git(MR, 'rev-parse', m['base'] + '^{tree}').strip(),
    'why': 'continues frozen-1951 durability2 (and frozen-1852 m-durability), whose base descends from the unpublishable pre-rewrite c635fd68; full trees not claimed',
    'verified': "base-files/ (empty when every touched path is new) + this side's patches reproduce every touched path's blob at every commit (verify-frozen-2025-export.py)"}
F1951 = json.loads(git(checkpoint, 'show', f'{CHECKPOINT_HEAD}:checkpoints/decentralization-20261022/closeout-followup/files/source-preservation/frozen-1951-export/INVENTORY.json'))
assert m['commits'][0]['parent'] == F1951['sides']['durability2']['head'], 'durability3 does not continue the pushed durability2 head'
last = {e['path']: e['blob'] for e in F1951['sides']['durability2']['commits'][-1]['touchedBlobs']}
assert all(b['blob'] == last[b['path']] for b in m['baseFiles'] if last.get(b['path'])), 'base files != frozen-1951 head blobs'
for k, want in (('custody-release2', 'custody-release'), ('dashboard2', 'dashboard'), ('custody-live3', 'custody-live2')):
    assert sides[k]['base'] == F1951['sides'][want]['head'], (k, 'base is not the pushed frozen-1951 head')
NOTES = {
 'durability3': ('custody v2 durability ab589bf8 on a5eae96c: tests that run the REAL custodian daemon startup against a host /state server '
                 '(every read failure refuses to start and writes nothing; only an explicit 404 seals a fresh identity) and the REAL Caddy ingress '
                 'in front of the REAL router (25 host-binding route spellings never reach the guest). Source/test only; the r2 image is built from it'),
 'custody-release2': ('ROOT corrected custodian r2 from ab589bf8: two clean-clone byte-identical builds (measurement 70aadff5), v4 verification, '
                      'SNP canary handoff (da6e3496), and the reviewed r2 provenance and superseded-image limits (23f7e51a). Committed SCAN-REVIEW.txt '
                      'classifies the scanner hits (public snpkey executable SHA256, public canary X25519 encKey). Images, clones, raw quotes, serial '
                      'logs and state are not versioned. NOT production activated'),
 'dashboard2': ('R custody v2 dashboard on 4acad4a7: seats counted as the vault counts them (single-seat bootstrap only when n = 1), per-call book '
                're-read, precise SessionVault refusal, agreed-read snapshot fix; tests against the REAL original vault, book and SessionVault on '
                'anvil; docs. Source/test only; not deployed'),
 'custody-live3': ('ROOT live custody reconciliation on 70019fdf: custody authority reconciled, UNSIGNED enrollment/discovery/book/factory activation '
                   'plans, activation-dependency reconciliation and preserved public live-read evidence. Read-only; nothing signed or sent; no secrets, '
                   'sealed state or private config; existing single-seat bootstrap (NOT decentralized custody)'),
 'wallet-handoff': ('D metal0 host-owner enrollment loopback MetaMask handoff 7b49cd99, source only, inactive. Its plain-transfer fund stage REFUSES '
                    'the operator (root live preflight 20:12Z: the operator carries an EIP-7702 delegation) and is NOT usable for funding; the '
                    'acceptOwner stage is unaffected. Nothing was served, signed, sent or funded'),
 'operator-proposal': ('metal0 operator proposeOwner(metal0, Enclave wallet) helper f2a7b81e: prepare by default, journaled explicit send for root, '
                       'pinned exact EIP-7702 delegation and executor runtime; fake-chain tests with a test key; plus its committed PROGRESS note '
                       '(1ac9ad2c). Nothing was signed or sent'),
 'snp-harness': ('SNP startup-recovery canary harness e9b9709a (fresh / GET-503 refusal / same-identity reopen) and ROOT corrected-image hardware '
                 'evidence 7c4844a1 (20261023T201449Z: quote-only startup and outage recovery; not secret release or lifecycle). Committed '
                 'SCAN-REVIEW.md classifies the encKey hits (public X25519 key of a disposable custodian). Raw quotes, guest console logs, private '
                 'configuration, sealed bytes and keys are excluded by the repository itself'),
 'direct-route': ('Custody v2 direct public ingress on metal0: source-only routing assessment (canary and permanent host-role options), with its '
                  'committed probe/scan outputs. Nothing deployed'),
}
for k, v in NOTES.items():
    if k in sides: sides[k]['note'] = v
derivs = {}
for k, s in DERIVS.items():
    d = export(k, s, exclude=s['exclude'])
    assert not forbidden(d), k
    assert d['headTree'][:8] == TREES[k], (k, 'original head tree')
    omitted = {}
    for c in d['commits']:
        c['originalTree'] = c['tree']; c['tree'] = derived_tree(s['repo'], c['commit'], s['exclude'], s.get('hold'))
        omitted[c['commit']] = [dict(zip(('mode', 'type', 'blob', 'bytes', 'path'), l.split(None, 4)))
                                for x in s['exclude'] for l in git(s['repo'], 'ls-tree', '-r', '-l', c['commit'], '--', x).splitlines()]
    d['originalHeadTree'] = d['headTree']; d['headTree'] = d['commits'][-1]['tree']
    d['omittedAtHead'] = [{**a, 'sha256': sha(git(s['repo'], 'cat-file', 'blob', a['blob'], text=False))} for a in omitted[d['head']]]
    d['excluded'] = list(s['exclude'])
    # SANITIZED evidence copies of omitted files: the flagged public values replaced by a fixed placeholder; the ORIGINAL blob and sha256
    # are recorded with the reason. Not the original bytes: no reproduction claim for them
    d['sanitized'] = []
    for path, (pattern, placeholder, reason) in s.get('sanitize', {}).items():
        import re
        orig = git(s['repo'], 'cat-file', 'blob', git(s['repo'], 'rev-parse', f"{d['head']}:{path}").strip(), text=False).decode()
        new, n = re.subn(pattern, placeholder, orig)
        assert n > 0, (k, path, 'nothing sanitized')
        t = out / s['name'] / 'sanitized' / path; t.parent.mkdir(parents=True, exist_ok=True); t.write_text(new)
        d['sanitized'].append({'path': path, 'originalBlob': git(s['repo'], 'rev-parse', f"{d['head']}:{path}").strip(), 'originalSha256': sha(orig.encode()),
                               'file': str(t.relative_to(out)), 'sha256': sha(new.encode()), 'replacements': n, 'placeholder': placeholder, 'reason': reason,
                               'claim': 'SANITIZED EVIDENCE DERIVATIVE, not the original bytes; restore the original from the source repository by originalBlob'})
    d['label'] = 'SOURCE-ONLY DERIVATIVE: ' + NOTES[k] + '; ' + s['labelOmission']
    d['omittedRecipe'] = s['recipe']
    derivs[k] = d
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
inventory = {'format': 'enclave-frozen-2025-export/v1', 'checkpointHeadAtExport': CHECKPOINT_HEAD,
    'batch': '2025 = the batch start 2026-10-23T20:25Z (date -u): an identifier, not a publication time and not a year',
    'label': ('SOURCE + EVIDENCE ONLY. Custody v2: durability ab589bf8 (daemon-startup and ingress-path tests), ROOT corrected custodian r2 '
              '(reproducible build, NOT activated), R dashboard e24a47fb (source/test), ROOT live reconciliation 3fd6e8ff (read-only, unsigned plans), '
              'SNP startup-recovery harness and quote-only hardware evidence, direct-route assessment, metal0 operator-proposal helper and the '
              'metal0 MetaMask handoff (its plain-transfer fund stage refuses the delegated operator; not usable). Nothing signed, sent, funded, '
              'served or activated by this capture. Existing custody is the original single-seat bootstrap, NOT decentralized custody.'),
    'sides': sides, 'derivatives': derivs, 'lowercaseRewrittenLiteral': lit, 'frozenSources': frozen, 'rootEvidence': evidence,
    'snapshotsUnchangedSince1852': ['ROOT-PENDING-LATEST.txt', 'effective-goal-requirements.txt'],
    'evidenceVsSource': 'Committed logs, receipts, run outputs and RESULT files inside these repositories are EVIDENCE; the rest is source.',
    'notPreserved': ['ignored/untracked files in every repo: images, binaries, node_modules, raw quotes, guest console logs, sealed state, private '
                     'config, keys, canary run directories, task prompts and progress/err files of workers',
                     'commits after these heads and every worktree change',
                     'outer non-repo files of these work directories']}
(out / 'INVENTORY.json').write_text(json.dumps(inventory, indent=1) + '\n')
print(json.dumps({k: {'commits': len(v['commits']), 'files': len(v['changedFiles'])} for k, v in {**sides, **derivs}.items()}
                 | {'frozen': len(frozen), 'rootEvidence': len(evidence), 'inventorySha256': sha((out / 'INVENTORY.json').read_bytes())}))

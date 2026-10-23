"""Export the frozen-1806 batch for the checkpoint, from Git OBJECTS only (never from mutable or dirty worktrees). "1806" is the batch
IDENTIFIER = its actual start, 2026-10-23T18:06Z (date -u); it is not a publication time. Root-designated immutable heads only
(ROOT-PENDING-LATEST 18:01Z and root's message); the CPU guest/image build WIP and M's new durability work are excluded.

First-parent series on a base already preserved in pushed checkpoint material (6dcde703), or a root commit:
* root-cpu-build  coupled-cpu-enforcement-20261023/root-validation c516049c (frozen-1726 root-cpu-canary head) -> 6ac5e111 (launcher
                  pin), c57a5f47 (offline native MSVC launcher build evidence; committed text only - the ignored *.exe / *.zip are
                  never in a commit)
* custody-audit   custody-v2-rollout-audit-20261023 root -> 5c263df1, 8d17bd6, 167ed43, 8df7139d (committed report only)
No source-only derivatives: every side reproduces its exact trees.
"""
from pathlib import Path
import hashlib, json, os, shutil, subprocess, tempfile

root = Path(__file__).resolve().parents[3]
W = root / 'work'
base = W / 'resume-after-checkpoint-20261022'
sp = base / 'source-preservation'
out = sp / 'frozen-1806-export'
checkpoint = W / 'source-checkpoint-20261022/main-repo'
CHECKPOINT_HEAD = '6dcde703004dcb34e702ec2aff8309e48ced44ae'
AUTHOR = 'SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'
# OLD = the former provider name the 2026-10-21 repository rewrite replaced by 'Cloud Provider'; built from hex so this tool
# itself does not carry the literal it guards against
OLD = bytes.fromhex('54696e666f696c')
R = lambda repo, name, branch, b, head, commits, prov, **kw: {'repo': repo, 'name': name, 'branch': branch, 'base': b, 'head': head,
                                                              'commits': commits.split(), 'baseProvenance': prov, **kw}
ROOTC = 'root commit (ROOT repo)'
SIDES = {
    'root-cpu-build': R(W / 'coupled-cpu-enforcement-20261023/root-validation', 'root-cpu-build-c57a5f47', 'master',
                        'c516049cb763149ad261b32c7eac16524d49b939', 'c57a5f4733b672b7079819e0208539a24df642b3', '6ac5e111 c57a5f47',
                        'c516049c preserved in 6dcde703 (frozen-1726 root-cpu-canary head)'),
    'custody-audit': R(W / 'custody-v2-rollout-audit-20261023', 'custody-audit-8df7139d', 'audit/custody-v2', None,
                       '8df7139db235526f33fee658f592c751d266b884', '5c263df 8d17bd6 167ed43 8df7139', ROOTC),
}
FROZEN = ['source-preservation/' + n for n in ('RESULT-frozen-1726-checkpoint.md', 'snapshots-1806/ROOT-PENDING-LATEST.snapshot-1806.txt',
          'snapshots-1806/effective-goal-requirements.snapshot-1806.txt')]
ROOT_EVIDENCE = ['../../outputs/decentralization-audit/' + n for n in ('nucbox-cpu-launcher-built-20261023.json', 'custody-v2-source-audit-20261023.md')]


import atexit
_ATTR = tempfile.NamedTemporaryFile('w', suffix='.attributes', delete=False); _ATTR.write('* diff=nofunc1806\n'); _ATTR.close(); atexit.register(os.unlink, _ATTR.name)
NOFUNC = ('-c', f'core.attributesFile={_ATTR.name}', '-c', 'diff.nofunc1806.xfuncname=^$')


def git(repo, *args, text=True, env=None):
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=text, env=env).stdout


def sha(data):
    return hashlib.sha256(data).hexdigest()


def export(key, spec):
    # a FIRST-PARENT series: one patch per commit (format-patch of <first parent>..<commit>); no merges in this batch
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
        assert len(ps) <= 1, f'{key}: unexpected merge {r["commit"]}'
    assert len(rows) == len(spec['commits']) and [r['commit'][:len(c)] for r, c in zip(rows, spec['commits'])] == spec['commits'], \
        f"{key}: commits {[r['commit'][:9] for r in rows]} != {spec['commits']}"
    assert rows[0]['parent'] == (base_full or ''), f'{key}: first parent'
    assert all(rows[i]['parent'] == rows[i - 1]['commit'] for i in range(1, len(rows))), f'{key}: not a first-parent series'
    assert all(r['author'] == AUTHOR and r['committer'] == AUTHOR for r in rows), f'{key}: unexpected author/committer'
    files = []
    diff_args = [base_full, head] if base_full else ['4b825dc642cb6eb9a060e54bf8d69288fbee4904', head]
    for line in git(repo, 'diff', '--name-status', '--no-renames', *diff_args).splitlines():
        status, path = line.split('\t')
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
    patches = []
    for n, r in enumerate(rows, 1):
        c = r['commit']
        data = git(repo, *NOFUNC, 'format-patch', '--stdout', '--full-index', '--no-renames', '--no-signature',
                   *(['--root', '-1', c] if not r['parent'] else [f"{r['parent']}..{c}"]), text=False)
        assert data.strip(), (key, c)
        f = dst / 'patches' / f'{n:04d}-{c[:8]}.patch'
        f.write_bytes(data); r['patch'] = str(f.relative_to(out)); patches.append(f)
    for p in patches:
        p.read_bytes().decode('utf-8')
        assert b'GIT binary patch' not in p.read_bytes(), p
    reach = subprocess.run(['git', '-C', str(repo), 'merge-base', '--is-ancestor', head, spec['branch']]).returncode == 0
    assert reach, f'{key}: head not on {spec["branch"]}'
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
rb, ca = sides['root-cpu-build'], sides['custody-audit']
assert rb['headTree'] == 'ec62bb6bc78cf441958cb7f68eb360a0145154dc' and ca['headTree'] == 'f3aa86acb83fed9f83401fc02c5889a704fbc593', 'head trees'
F1726 = json.loads((sp / 'frozen-1726-export/INVENTORY.json').read_text())
assert F1726['sides']['root-cpu-canary']['head'] == rb['base'] and F1726['sides']['cpu-enforce']['head'] == 'ea6717d2725b8acd1b19837cdc6355421a94972d'
# the build's binaries and source zip stay untracked and ignored: no committed path is an executable or archive
assert not [f['path'] for s in sides.values() for f in s['changedFiles'] if f['path'].endswith(('.exe', '.zip', '.dll', '.pdb'))]
rb['note'] = ('ROOT: 6ac5e111 pins the installed Windows launcher; c57a5f47 records an offline/locked native MSVC build of the CPU allowance '
              'launcher from the 18-file ea6717d2 source closure (ea6717d2 captured in frozen-1726 cpu-enforce): build scripts, the 18-file '
              'source SHA manifest and evidence. Candidate e4eeb994292dcd71653243da1e64d23988ec8a7f45f2b3742a517dda3d46feb2 (1,147,904 B) is '
              'STAGED ONLY; the candidate/installed .exe and the source .zip are untracked+ignored and NOT captured. Guest, manager and live '
              'installed files unchanged; 9 apps running at 17:57 with the same 10 manager VM IDs, 17% CPU, 16.3 GiB. Documented: the guard '
              'harness\'s initial detached exit and null ExitCode / multiline parse issues; the corrected command exit file confirms Cargo 0. '
              'Cold build 49.09 s, peak 309,899,264 B, min free 26,454,904,832 B; the incremental 0.27 s ran under the memory sampling '
              'period, so its raw 0 / 1e12 values are sentinels, not observations. The whole CPU fix is INCOMPLETE: the guest build and '
              'the native combined canary are pending')
ca['note'] = ('M custody v2 rollout audit, committed report only: a SOURCE / HISTORICAL-RECORD audit with NO fresh production probe, rollout '
              'or tests. Findings include an actual persist-before-ack bug, migration old-copy retention limits, the dashboard missing and '
              'the book historically unset, and that one seat is NOT decentralized. Untracked root review notes and progress are not captured')
# ---- literal guard ----------------------------------------------------------------------------------------------------------
lit = {}
for q in out.rglob('*'):
    if q.is_file():
        bb = q.read_bytes(); n = (bb.count(OLD), bb.count(OLD.lower()))
        if any(n): lit[str(q.relative_to(out))] = n
for name in FROZEN + ROOT_EVIDENCE:
    bb = (base / name).resolve().read_bytes(); n = (bb.count(OLD), bb.count(OLD.lower()))
    if any(n): lit['frozen:' + name] = n
assert not any(v[0] for v in lit.values()), ('capitalised rewritten literal in export', {k: v for k, v in lit.items() if v[0]})
frozen = {name: sha((base / name).resolve().read_bytes()) for name in FROZEN}
evidence = {name: sha((base / name).resolve().read_bytes()) for name in ROOT_EVIDENCE}
inventory = {'format': 'enclave-frozen-1806-export/v1', 'checkpointHeadAtExport': CHECKPOINT_HEAD,
    'batch': '1806 = the batch start 2026-10-23T18:06Z (date -u): an identifier, not a publication time',
    'label': ('SOURCE + EVIDENCE ONLY; not production completion. ROOT native CPU launcher build evidence c57a5f47 (candidate staged only, binaries '
              'not captured; the whole CPU fix is incomplete) and M\'s custody v2 rollout audit 8df7139d (source/historical record, no fresh '
              'production verification; one seat is not decentralized custody).'),
    'sides': sides, 'derivatives': {}, 'lowercaseRewrittenLiteral': lit, 'frozenSources': frozen, 'rootEvidence': evidence,
    'evidenceVsSource': 'Committed logs, receipts, run outputs and RESULT files inside these repositories are EVIDENCE; the rest is source.',
    'notPreserved': ['root-validation untracked/ignored files: candidate-shield-host.exe, installed-shield-host.exe, native-loader-source.zip, '
                     'later guard logs', 'custody audit untracked ROOT-AUDIT-REVIEW-1.txt, ROOT-OUTAGE-ISOLATION.txt, claude-progress.txt',
                     'the CPU guest/image build WIP (Q/R), M\'s new durability work, and every other active tree or final (P/S/A/F/C/M/T)']}
(out / 'INVENTORY.json').write_text(json.dumps(inventory, indent=1) + '\n')
print(json.dumps({k: {'commits': len(v['commits']), 'files': len(v['changedFiles'])} for k, v in sides.items()}
                 | {'frozen': len(frozen), 'rootEvidence': len(evidence), 'literalFiles': len(lit),
                    'inventorySha256': sha((out / 'INVENTORY.json').read_bytes())}))

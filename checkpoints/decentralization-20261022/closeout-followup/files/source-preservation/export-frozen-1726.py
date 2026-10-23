"""Export the frozen-1726 resource-repair batch for the checkpoint, from Git OBJECTS only (never from mutable or dirty worktrees).
"1726" is the batch IDENTIFIER = its actual start, 2026-10-23T17:26Z (date -u); it is not a publication time. Root-reviewed immutable
heads only (ROOT-PENDING-LATEST 17:04Z and later notes, and root's 17:2xZ message); the CPU worker's new build workspace, its outer
build/progress files and every other active tree are excluded.

First-parent series; every base is preserved in pushed checkpoint material (1219a988) or earlier in THIS batch, or a root commit:
* node-shares     coupled-resource-shares-20261023/repo d281007c (pushed: rpc-native-codec-export side c, 6th commit) ->
                  0f1ef848 (installed NucBox control baseline, root snapshot) -> 14b24592 -> a5e155ec (coupled-share fix)
* cpu-enforce     coupled-cpu-enforcement-20261023/repo 0f1ef848 (node-shares 1st commit) -> 670a753e (manager), bf376363 (test
                  seam), ea6717d2 (guest)
* cpu-oldguest    same repo, 670a753e (cpu-enforce 1st commit) -> 15ad0042 (branch old-guest-b; root's native canary kit source)
* node-report     coupled-resource-shares-20261023 (outer report repo) root -> d10a78cb, 33ba0fc3 (committed tree only)
* root-cpu-canary coupled-cpu-enforcement-20261023/root-validation root -> c516049c (root-run native Hyper-V canary)
No source-only derivatives: every side reproduces its exact trees.
"""
from pathlib import Path
import hashlib, json, os, shutil, subprocess, tempfile

root = Path(__file__).resolve().parents[3]
W = root / 'work'
base = W / 'resume-after-checkpoint-20261022'
sp = base / 'source-preservation'
out = sp / 'frozen-1726-export'
checkpoint = W / 'source-checkpoint-20261022/main-repo'
CHECKPOINT_HEAD = '1219a9882904b73349aee9582a9e35b355c03e26'
AUTHOR = 'SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'
# OLD = the former provider name the 2026-10-21 repository rewrite replaced by 'Cloud Provider'; built from hex so this tool
# itself does not carry the literal it guards against
OLD = bytes.fromhex('54696e666f696c')
R = lambda repo, name, branch, b, head, commits, prov, **kw: {'repo': repo, 'name': name, 'branch': branch, 'base': b, 'head': head,
                                                              'commits': commits.split(), 'baseProvenance': prov, **kw}
ROOTC = 'root commit (ROOT repo)'
NR, CR = W / 'coupled-resource-shares-20261023', W / 'coupled-cpu-enforcement-20261023'
BASELINE = '0f1ef848b21e03f6fd6c4852d7cccff6f18ba2b2'
SIDES = {
    'node-shares': R(NR / 'repo', 'node-shares-a5e155ec', 'coupled-shares', 'd281007c234031e5729b882b4e9ff3d9e4ffd5ad',
                     'a5e155ecfd9b71faa8f1e853d65bcc08efea7b5a', '0f1ef848 14b24592 a5e155ec',
                     'd281007c preserved in 1219a988 (rpc-native-codec-export side c, 6th commit; tree a9eeada5)'),
    'cpu-enforce': R(CR / 'repo', 'cpu-enforce-ea6717d2', 'cpu-enforcement', BASELINE,
                     'ea6717d2725b8acd1b19837cdc6355421a94972d', '670a753e bf376363 ea6717d2',
                     '0f1ef848 = node-shares 1st commit in THIS batch (the same commit object in both repos)'),
    'cpu-oldguest': R(CR / 'repo', 'cpu-oldguest-15ad0042', 'old-guest-b', '670a753e05f85180d71402f3d8b6dbda13ae55fa',
                      '15ad00420733ea47a5747a14687a4afb3e12a14a', '15ad0042', '670a753e = cpu-enforce 1st commit in THIS batch'),
    'node-report': R(NR, 'node-report-33ba0fc3', 'master', None, '33ba0fc3ef5006c9be7874dd6e7fe287d07b7fda', 'd10a78cb 33ba0fc3', ROOTC),
    'root-cpu-canary': R(CR / 'root-validation', 'root-cpu-canary-c516049c', 'master', None, 'c516049cb763149ad261b32c7eac16524d49b939',
                         'c516049c', ROOTC),
}
CO = '../coupled-cpu-enforcement-20261023/'
KIT = ('windows/vbslike/manager/cpu-share.mjs', 'windows/vbslike/manager/egress.mjs', 'windows/vbslike/manager/ops/launcher-canary.mjs',
       'windows/vbslike/manager/psrun.mjs', 'windows/vbslike/manager/wmi-launcher.mjs', 'windows/vbslike/manager/wmiserve-run.mjs',
       'windows/vbslike/verify/boot-statements.mjs')
FROZEN = ([CO + n for n in ('FINAL.txt', 'native-canary/run-cpu-canary.ps1', 'native-canary/KIT-EXPECTED.json', 'native-canary/KIT-MANIFEST.json',
                            'native-canary/NATIVE-CANARY.txt')]
          + ['source-preservation/' + n for n in ('RESULT-frozen-1639-checkpoint.md', 'snapshots-1726/ROOT-PENDING-LATEST.snapshot-1726.txt',
             'snapshots-1726/effective-goal-requirements.snapshot-1726.txt')])
ROOT_EVIDENCE = ['../../outputs/decentralization-audit/' + n for n in ('nucbox-cpu-share-native-canary-20261023.json',
                                                                      'nucbox-coupled-accounting-active-20261023.json')]


import atexit
_ATTR = tempfile.NamedTemporaryFile('w', suffix='.attributes', delete=False); _ATTR.write('* diff=nofunc1726\n'); _ATTR.close(); atexit.register(os.unlink, _ATTR.name)
NOFUNC = ('-c', f'core.attributesFile={_ATTR.name}', '-c', 'diff.nofunc1726.xfuncname=^$')


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
ns, ce, og = sides['node-shares'], sides['cpu-enforce'], sides['cpu-oldguest']
assert [c['tree'][:8] for c in ns['commits']] == ['ab399272', '933292a5', '609d98c8'], 'node trees'
assert ce['commits'][0]['tree'].startswith('39648435') and ce['commits'][1]['tree'].startswith('9395b5cd') and ce['headTree'].startswith('5b1d4b5a')
assert og['headTree'].startswith('bdf8cee3') and sides['node-report']['headTree'].startswith('f7cd0dd7') and sides['root-cpu-canary']['headTree'].startswith('777366f2')
# the baseline commit is the same object in both repositories, and both CPU sides continue it / the manager commit
assert git(CR / 'repo', 'rev-parse', BASELINE + '^{tree}') == git(NR / 'repo', 'rev-parse', BASELINE + '^{tree}')
assert ns['commits'][0]['commit'] == ce['base'] and ce['commits'][0]['commit'] == og['base']
ns['note'] = ('0f1ef848 = installed NucBox control source baseline (root snapshot 2026-10-23 ~16:02-16:06Z; installed-source overlays on d281007c), '
              '14b24592 + a5e155ec = the coupled-share fix: production files windows/node/{host,chain,isolation-client}.mjs plus regression '
              'fixtures/tests. Node worker tests per root review: new 14/14; defect 6/6 (0/6 on the baseline); client 27/27; memory 1/1; hosting '
              '25/25; isolation 15/15; preclaim 5/5; scan 13/13. Broad suite 222/233 = the same 11 pre-existing baseline fixture failures, which '
              'are documented and NOT called green. Root-activated natively on the NucBox (node-report); not re-run by D')
ce['note'] = ('CPU worker final: A 670a753e manager (one share sizes VPs as well as RAM), S bf376363 test seam (no behaviour change), B ea6717d2 '
              'guest (launcher CPU allocation raises the domain cgroup cpu.max, and is confirmed). CPU call chain 11/11 (2/11 on the baseline); '
              'guest real-load seam 3/3 (1/3 on the baseline), per root review; not re-run by D. NOT a full fix: the manager/guest rollout is '
              'pending (guest image + shield-host.exe); the CPU worker is building in a NEW workspace, which is not captured')
og['note'] = ('15ad0042 (branch old-guest-b) = the earlier guest change superseded by S+B; retained because root\'s native canary kit '
              'references it. The canary kit files are byte-identical at 15ad0042 and ea6717d2 (nativeKit, asserted)')
sides['node-report']['note'] = ('ROOT-reviewed NucBox coupled-share rollout report: native node activation, root rollback helper, VM snapshots, TLS '
              'retries and public fleet API evidence (17:22:15 public API: 17% CPU, 16.3 GiB RAM of 96 GB, all 9 apps running, c13 resized '
              '983 -> 1966 MiB / 2%, other 8 VM IDs unchanged; all 9 public TLS/HTTP 200 by 17:18). Committed tree only; the untracked '
              'installed/, delivery/files/, logs/, jobs/, root notes and live-read files are NOT captured. The whole CPU fix is NOT complete')
sides['root-cpu-canary']['note'] = ('ROOT-run native Hyper-V type-1 canary on the current image: 1%/21%/13% exact WMI limit and reservation, all '
              'guest VPs online, cleanup 0, the 12 original VM IDs/states and manager PID 2376 unchanged. No production manager or image '
              'was updated. Guest cgroup enforcement is NOT yet native. Committed tree only')
# the native canary kit (copied by the CPU worker under native-canary/kit/) is the same bytes as the repo blobs at 15ad0042 and ea6717d2
kitdir = CR / 'native-canary/kit'
assert sorted(str(p.relative_to(kitdir)) for p in kitdir.rglob('*') if p.is_file()) == sorted(KIT), 'native kit file set'
km = {x['path']: x['sha256'] for x in json.loads((CR / 'native-canary/KIT-MANIFEST.json').read_text())['kit']}
nk = []
for p in KIT:
    b15, bea = (git(CR / 'repo', 'rev-parse', f'{c}:{p}').strip() for c in (og['head'], ce['head']))
    h = sha((kitdir / p).read_bytes())
    assert b15 == bea and h == sha(git(CR / 'repo', 'cat-file', 'blob', b15, text=False)) and km.get(p) == h, p
    nk.append({'path': p, 'blob': b15, 'sha256': h})
assert set(km) == set(KIT), 'KIT-MANIFEST lists other files'
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
inventory = {'format': 'enclave-frozen-1726-export/v1', 'checkpointHeadAtExport': CHECKPOINT_HEAD,
    'batch': '1726 = the batch start 2026-10-23T17:26Z (date -u): an identifier, not a publication time',
    'label': ('SOURCE + EVIDENCE ONLY for the coupled resource-share repair; not production completion. Node coupled-share fix a5e155ec (on the '
              'installed baseline 0f1ef848) with root\'s activation report 33ba0fc3; CPU enforcement source 670a753e/bf376363/ea6717d2 (+ retained '
              'old-guest-b 15ad0042) and root\'s native Hyper-V canary c516049c. The entire CPU resource fix is NOT complete: the manager/guest '
              'rollout is pending and guest cgroup enforcement is not yet native. Known pre-existing fixture failures (11 in the broad suite) are '
              'NOT called green.'),
    'sides': sides, 'derivatives': {}, 'nativeKit': {'dir': 'work/coupled-cpu-enforcement-20261023/native-canary/kit', 'files': nk,
        'note': 'kit copies = repo blobs at 15ad0042 and ea6717d2 (asserted) and KIT-MANIFEST.json sha256s; no prebuilt binary in the kit'},
    'lowercaseRewrittenLiteral': lit, 'frozenSources': frozen, 'rootEvidence': evidence,
    'evidenceVsSource': 'Committed logs, receipts, run outputs and RESULT files inside these repositories are EVIDENCE; the rest is source.',
    'notPreserved': ['the CPU worker\'s NEW build workspace and outer build/progress files (build/, freeze/, scratch/, seam-tree/, baseline-tree/, '
                     'BUILD-*.txt, *progress*.txt, run-*.sh, logs/) and any binary; its ROOT-*.txt coordination notes',
                     'untracked files of the node report repo (installed/, delivery/files/, delivery/rollback/, delivery/installed-to-fix.patch, '
                     'installed-*-manifest.json, jobs/, logs/, root notes, read-*.py, cpu-live.json, guard logs) and of root-validation',
                     'resource-guest-lineage-20261023 and every other active tree; M sealed-startup and T HDD client recovery (later batch)']}
(out / 'INVENTORY.json').write_text(json.dumps(inventory, indent=1) + '\n')
print(json.dumps({k: {'commits': len(v['commits']), 'files': len(v['changedFiles'])} for k, v in sides.items()}
                 | {'frozen': len(frozen), 'rootEvidence': len(evidence), 'nativeKit': len(nk), 'literalFiles': len(lit),
                    'inventorySha256': sha((out / 'INVENTORY.json').read_bytes())}))

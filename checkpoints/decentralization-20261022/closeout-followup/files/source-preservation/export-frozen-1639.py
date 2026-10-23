"""Export the frozen-1639 batch for the checkpoint, from Git OBJECTS only (never from mutable or dirty worktrees). "1639" is the batch
IDENTIFIER = its actual start, 2026-10-23T16:39Z (date -u); it is not a publication time. Root-accepted terminal immutable heads only
(ROOT-PENDING-LATEST 15:46-16:09Z); the coupled resource-share WIP and every other active tree are excluded.

First-parent series on a base already preserved in pushed checkpoint material (b995a73b), or root commits:
* e-gen          site-generated-artifacts-reconcile-20261023/repo ae00cd96 (frozen-1517 e-prod head) -> ff13ebe0 (tree 1cece8e6)
* root-ram96c    nucbox-ram96-20261023 2ed6ba61 (frozen-1339) -> 6b756f84 (96 GiB activation), e650fc09 (headroom), 3d42d7eb (share mismatch)
* root-rpc-review root-rpc-integration-review-20261023 root -> 1d4920ca, 803c6975
* root-api-mcp2  api-mcp-recovery-20261023 95ee73dc (frozen-1517) -> 844edbf2
SOURCE-ONLY DERIVATIVES:
* a-cv           credit-vault-submitter-verifier-20261023/repo eab4cfac (frozen-1517 a-receipts DERIVATIVE head) -> 2 commits -> fd8d5806
                 (tree d8e0ab06): the compiled MCP guest bundle + manifest stay held at e32dd607 (this range does not touch them; their
                 eab4cfac bytes were validated in frozen-1517)
* e-gen-report   site-generated-artifacts-reconcile-20261023 root -> d37f7a04 (root-accepted report), minus exports/ (git bundle + patch)
"""
from pathlib import Path
import hashlib, json, os, shutil, subprocess, tempfile

root = Path(__file__).resolve().parents[3]
W = root / 'work'
base = W / 'resume-after-checkpoint-20261022'
sp = base / 'source-preservation'
out = sp / 'frozen-1639-export'
checkpoint = W / 'source-checkpoint-20261022/main-repo'
CHECKPOINT_HEAD = 'b995a73b6b3ae51d1812607da0e4d8ea6fd32f6e'
AUTHOR = 'SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'
# OLD = the former provider name the 2026-10-21 repository rewrite replaced by 'Cloud Provider'; built from hex so this tool
# itself does not carry the literal it guards against
OLD = bytes.fromhex('54696e666f696c')
R = lambda repo, name, branch, b, head, commits, prov, **kw: {'repo': repo, 'name': name, 'branch': branch, 'base': b, 'head': head,
                                                              'commits': commits.split(), 'baseProvenance': prov, **kw}
ROOTC = 'root commit (ROOT repo)'
SIDES = {
    'e-gen': R(W / 'site-generated-artifacts-reconcile-20261023/repo', 'e-gen-ff13ebe0', 'site-generated-artifacts-reconcile', 'ae00cd9659e46e3dffe5407bdf34442416a9e69a',
               'ff13ebe089f3c18a064892269c55ddca2b4409e9', 'ff13ebe0', 'ae00cd96 preserved in b995a73b (frozen-1517 e-prod head)'),
    'root-ram96c': R(W / 'nucbox-ram96-20261023', 'root-ram96c-3d42d7eb', 'master', '2ed6ba6115c4db7d49e2ce0fce78dbdd0d786c46',
                     '3d42d7eb9e9828b735e9a48fd0e067f60c74002b', '6b756f84 e650fc09 3d42d7eb', '2ed6ba61 preserved in b995a73b (frozen-1339 root-ram96b head)'),
    'root-rpc-review': R(W / 'root-rpc-integration-review-20261023', 'root-rpc-review-803c6975', 'master', None, '803c69757520e484a2ee0c690a76ba974a6534ea',
                         '1d4920ca 803c6975', ROOTC),
    'root-api-mcp2': R(W / 'api-mcp-recovery-20261023', 'root-api-mcp2-844edbf2', 'master', '95ee73dcd936fc9d0243c65c2f933e2ac277b3ac',
                       '844edbf2227086eae2f85bed05214a60508feb8d', '844edbf2', '95ee73dc preserved in b995a73b (frozen-1517 root-api-mcp head)'),
}
MCP = 'metal/guest/mcp-server.bundle.mjs'
CVM = 'network/host-services/packages/credit-vault-submitter.package.json'   # its blob at e32dd607 == at eab4cfac (last changed 6f2c7da4)
F1517 = json.loads((sp / 'frozen-1517-export/INVENTORY.json').read_text())
DERIVS = {
    'a-cv': R(W / 'credit-vault-submitter-verifier-20261023/repo', 'a-cv-fd8d5806', 'cv-submitter-verifier', 'eab4cfac47a00dcbc0161918a2624eed6761bbfb',
              'fd8d58061196c6d089ca21fb7948c6ba640d5c39', 'TBD', 'eab4cfac preserved in b995a73b as the frozen-1517 a-receipts DERIVATIVE (MCP bundle + manifest held at e32dd607)',
              exclude=(MCP, MCP + '.manifest.json', CVM), hold='e32dd607b55b9c6afd605482a4bc31c9d30528d6'),
    'e-gen-report': R(W / 'site-generated-artifacts-reconcile-20261023', 'e-gen-report-d37f7a04', 'master', None, 'd37f7a0467eacc6a5ea155e322de89aef6aa64d2',
                      'd37f7a04', 'root commit (E generated-artifacts report repo); SOURCE-ONLY DERIVATIVE (exports/ omitted)', exclude=('exports/',)),
}
AC = '../credit-vault-submitter-verifier-20261023/'
FROZEN = ([AC + n for n in ('RESULT-CREDIT-VAULT-SUBMITTER.md', 'HANDOFF-CREDIT-VAULT-SUBMITTER.md', 'jobs/base-check.sh', 'jobs/build1.sh', 'jobs/t1.sh', 'jobs/q.sh')]
          + ['source-preservation/' + n for n in ('RESULT-frozen-1517-checkpoint.md', 'snapshots-1639/ROOT-PENDING-LATEST.snapshot-1639.txt',
             'snapshots-1639/effective-goal-requirements.snapshot-1639.txt')])
ROOT_EVIDENCE = ['../../outputs/decentralization-audit/' + n for n in ('checkpoint-4aaba75-verified-20261023.json', 'nucbox-96gb-active-20261023.json',
                                                                      'rpc-integration-review-20261023.json')]


import atexit
_ATTR = tempfile.NamedTemporaryFile('w', suffix='.attributes', delete=False); _ATTR.write('* diff=nofunc1639\n'); _ATTR.close(); atexit.register(os.unlink, _ATTR.name)
NOFUNC = ('-c', f'core.attributesFile={_ATTR.name}', '-c', 'diff.nofunc1639.xfuncname=^$')


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
sides = {k: export(k, s) for k, s in SIDES.items()}
assert sides['e-gen']['headTree'] == '1cece8e6571631ab23ca8403c706ee5166c69c64', 'E reconcile head tree (root)'
er = W / 'site-generated-artifacts-reconcile-20261023'
sides['e-gen']['note'] = ('root: 45/45 compiler provenance; executable bytecode, ABIs and admin identical (metadata-only differences); clean offline '
                          'production build 238 files; prior built JS/CSS identical, 17 HTML footer stamps only. Not deployed')
sides['root-ram96c']['note'] = 'root RAM activation (user-approved 15:25Z), headroom and share-mismatch evidence; tracked files only (untracked activation logs/readiness not captured)'
derivs = {}
for k, s in DERIVS.items():
    if s['commits'] == ['TBD']:
        s['commits'] = [c[:8] for c in git(s['repo'], 'rev-list', '--reverse', '--first-parent', f"{s['base']}..{s['head']}").split()]
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
a = derivs['a-cv']
assert a['originalHeadTree'] == 'd8e0ab0656646a1fecbd13a4a2ddd2e19f649b57', 'A cv-submitter head tree (root)'
prev = {x['path']: x['blob'] for x in F1517['derivatives']['a-receipts']['omittedAtHead']}
assert {x['path']: x['blob'] for x in a['omittedAtHead'] if x['path'] != CVM} == prev, 'the held MCP bundle/manifest changed since eab4cfac'
assert git(DERIVS['a-cv']['repo'], 'rev-parse', f'e32dd607b55b9c6afd605482a4bc31c9d30528d6:{CVM}') == git(DERIVS['a-cv']['repo'], 'rev-parse', f'eab4cfac47a00dcbc0161918a2624eed6761bbfb:{CVM}'), 'hold state of the role manifest'
a['omittedRecipe'] = ('unchanged since frozen-1517 a-receipts (identical blobs): its omittedRecipe, convertedManifest and the validated rebuild '
                      '(frozen-1517-a-bundle-check, --check rc 0) apply; no new rebuild was run')
pk = W / 'credit-vault-submitter-verifier-20261023/repo/network/host-services/packages'
pkg = {x['path']: x for x in a['changedFiles']}
cvb = pkg['network/host-services/packages/credit-vault-submitter.mjs']; cvm = next(x for x in a['omittedAtHead'] if x['path'] == CVM)
# the role MANIFEST pairs npm file names (privateKeyToAccount.js, setCoinbase.js) with 64-hex sha256s: both unchanged scanners flag it
# (gitleaks + scan-crypto-keys eth-key, frozen-1639-export-2), so it is omitted and published as 'sha256  path' text + the other fields
rawm = git(DERIVS['a-cv']['repo'], 'show', f"{a['head']}:{CVM}"); mm = json.loads(rawm)
conv = out / a['patches'][0]['file'].split('/')[0] / 'converted'; conv.mkdir(parents=True, exist_ok=True)
sums = ''.join(f'{v}  {k}\n' for k, v in mm['inputs'].items()); meta = {k: v for k, v in mm.items() if k != 'inputs'}
(conv / 'credit-vault-submitter.package.inputs.sha256sums').write_text(sums); (conv / 'credit-vault-submitter.package.meta.json').write_text(json.dumps(meta, indent=2) + '\n')
keys = list(mm.keys())
assert json.dumps({kk: (dict(reversed(l.split('  ', 1)) for l in sums.splitlines()) if kk == 'inputs' else meta[kk]) for kk in keys}, indent=2) + '\n' == rawm
a['convertedManifest'] = {'path': CVM, 'files': [{'file': str((conv / n).relative_to(out)), 'sha256': sha((conv / n).read_bytes())}
    for n in ('credit-vault-submitter.package.inputs.sha256sums', 'credit-vault-submitter.package.meta.json')],
    'rebuild': f"json.dumps({{k: meta[k] for k in {keys}}} with inputs = dict((p, h) for each line 'h  p' in order), indent=2) + '\\n' (Python) == the committed manifest (asserted)"}
assert cvb['sha256'] == '4c25cde6d7f8c726dc2d57f92cf47630f067a6086ee6893d8e57d50f9fb619f6' and cvm['sha256'] == 'fa7403b5ef2d2872a40f33b0d42510a9d20dee0d851b665223fb93efaa77ef98', 'A role package pin (root)'
a['rolePackage'] = {'bundle': cvb['path'], 'bundleSha256': cvb['sha256'], 'manifest': cvm['path'], 'manifestSha256': cvm['sha256'],
                    'note': 'TRACKED in A\'s commit; the bundle is exported as committed text (as earlier committed bundles); the manifest is published converted (exact rebuild asserted); its rebuild was not re-run by D (A t1 50/50 per root)'}
a['label'] = ('SOURCE-ONLY DERIVATIVE continuing frozen-1517 a-receipts: the compiled MCP guest bundle + manifest stay held at e32dd607 bytes (untouched in '
              'this range); everything A changed, incl. its committed credit-vault-submitter role package, is exported. Mainnet readiness not established; '
              'minted receipts use labelled local fixtures (root)')
derivs['e-gen-report']['label'] = 'SOURCE-ONLY DERIVATIVE: E report repo at the root-accepted d37f7a04 minus exports/ (git bundle - binary - and a patch duplicating e-gen)'
eh = git(er, 'rev-parse', 'HEAD').strip()
derivs['e-gen-report']['laterCommitsNotCaptured'] = git(er, 'log', '--format=%H %s', 'd37f7a0467eacc6a5ea155e322de89aef6aa64d2..' + eh).splitlines()
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
inventory = {'format': 'enclave-frozen-1639-export/v1', 'checkpointHeadAtExport': CHECKPOINT_HEAD,
    'batch': '1639 = the batch start 2026-10-23T16:39Z (date -u): an identifier, not a publication time',
    'label': ('SOURCE + OFFLINE TESTS ONLY; candidates, not production completion. Root-accepted terminal heads since b995a73b: A credit-vault submitter '
              'fd8d5806 (state verifier + optional locally validated receipts; mainnet readiness not established), E generated-artifact reconcile '
              'ff13ebe0 + report d37f7a04, ROOT RAM activation/headroom/share-mismatch evidence 3d42d7eb, ROOT RPC integration review 803c6975, ROOT '
              'api-mcp 844edbf2. The coupled resource-share fix is ACTIVE WIP and is NOT here.'),
    'sides': sides, 'derivatives': derivs, 'lowercaseRewrittenLiteral': lit, 'frozenSources': frozen, 'rootEvidence': evidence,
    'evidenceVsSource': 'Committed logs, receipts, run outputs and RESULT files inside these repositories are EVIDENCE; the rest is source.',
    'notPreserved': ['A MCP guest bundle + manifest (held, as frozen-1517); E report exports/; E report commits after d37f7a04 (not root-accepted)',
                     'untracked/ignored files in every repo (node_modules, foundry out, relay network-runtime bundle, RAM activation logs/readiness, E gen-tree/verify-tree)',
                     'ACTIVE WIP: work/coupled-resource-shares-20261023, work/coupled-cpu-enforcement-20261023, baseline 0f1ef848b (provenance aid only), '
                     'A host-role-verifier-cold-closure, E bootstrap-replica publication, and every other active tree',
                     'other outputs receipts not designated for this batch (nucbox-tls-* operational receipts)']}
(out / 'INVENTORY.json').write_text(json.dumps(inventory, indent=1) + '\n')
print(json.dumps({k: {'commits': len(v['commits']), 'files': len(v['changedFiles'])} for k, v in {**sides, **derivs}.items()}
                 | {'frozen': len(frozen), 'rootEvidence': len(evidence), 'literalFiles': len(lit), 'inventorySha256': sha((out / 'INVENTORY.json').read_bytes())}))

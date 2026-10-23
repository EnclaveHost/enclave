"""Export the frozen-1852 batch for the checkpoint, from Git OBJECTS only (never from mutable or dirty worktrees). "1852" is the batch
IDENTIFIER = its actual start, 2026-10-23T18:52Z (date -u); it is not a publication time. Root-designated immutable heads only (root's
message); active Q build / A2 guest / debug artifacts, B cpu-root-scheduler-quota, R custody dashboard and M durability follow-up are
excluded. Ignored files (raw quote, node_modules, *.exe/*.bin/*.wasm) are never read: only committed objects are exported.

* root-cpu-quota  coupled-cpu-enforcement-20261023/root-validation c57a5f47 (frozen-1806 root-cpu-build head) -> 8afbf879: Windows
                  read-only policy/scheduler and 3 native CPU canaries = a FAILED Hyper-V cap (counterexample)
* custody-live    custody-v2-live-20261023 root -> a90f8339 (fresh read-only custody v2 verification)
* m-durability    custody-v2-durability-20261023/repo c635fd68 -> ed0c536d, 415483ff. The base c635fd68 (custody-release repo-b,
                  pre-rewrite history) is NOT in pushed material and its tree carries the rewritten literal, so only the TOUCHED FILES are
                  reproduced: their base blobs are stored under base-files/ (no literal) and every touched path's blob is checked
SOURCE-ONLY DERIVATIVES:
* guest-lineage   resource-guest-lineage-20261023/repo root -> 02863ae1 minus REPORT.md (it names a directory carrying the lowercase
                  rewritten literal; frozen-1852 content-check rc 1)
* b-consumer      linux-rpc-consumer-closure-20261023/repo 673601e5 (frozen-1339 b-launch, 27th commit) -> 9 commits -> c08532b2:
                  the compiled platform-api (8.9 MB) and mcp-server guest bundles are held at their 673601e5 bytes; the three bundle
                  manifests are held too and published CONVERTED (exact rebuild asserted)
"""
from pathlib import Path
import hashlib, json, os, shutil, subprocess, tempfile

root = Path(__file__).resolve().parents[3]
W = root / 'work'
base = W / 'resume-after-checkpoint-20261022'
sp = base / 'source-preservation'
out = sp / 'frozen-1852-export'
checkpoint = W / 'source-checkpoint-20261022/main-repo'
CHECKPOINT_HEAD = '7422efe6e2a5a3a132c622091b1ab619f280c2bc'
AUTHOR = 'SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'
# OLD = the former provider name the 2026-10-21 repository rewrite replaced by 'Cloud Provider'; built from hex so this tool
# itself does not carry the literal it guards against
OLD = bytes.fromhex('54696e666f696c')
R = lambda repo, name, branch, b, head, commits, prov, **kw: {'repo': repo, 'name': name, 'branch': branch, 'base': b, 'head': head,
                                                              'commits': commits.split(), 'baseProvenance': prov, **kw}
ROOTC = 'root commit (ROOT repo)'
SIDES = {
    'root-cpu-quota': R(W / 'coupled-cpu-enforcement-20261023/root-validation', 'root-cpu-quota-8afbf879', 'master',
                        'c57a5f4733b672b7079819e0208539a24df642b3', '8afbf879ae3960e1b958dad09ce0f331799f002c', '8afbf879',
                        'c57a5f47 preserved in 7422efe6 (frozen-1806 root-cpu-build head)'),
    'custody-live': R(W / 'custody-v2-live-20261023', 'custody-live-a90f8339', 'master', None, 'a90f8339e7225e185393a646a879feaf4853c5b1',
                      'a90f8339', ROOTC),
    'm-durability': R(W / 'custody-v2-durability-20261023/repo', 'm-durability-415483ff', 'custody/durability',
                      'c635fd68515b46c53935ef344e3b4c4779d8067c', '415483ff9784c38a88b273363a7efd0c227b95ce', 'ed0c536d 415483ff',
                      'c635fd68 (custody-release repo-b quote-tested candidate, pre-rewrite history) is NOT in pushed material: TOUCHED-FILE '
                      'reproduction only (base-files/), the full tree is not claimed'),
}
GB = 'metal/guest/'
BUNDLES = (GB + 'platform-api.bundle.mjs', GB + 'mcp-server.bundle.mjs')
MANIFESTS = tuple(GB + n + '.bundle.mjs.manifest.json' for n in ('lease-gas-conduit', 'mcp-server', 'platform-api'))
DERIVS = {
    'b-consumer': R(W / 'linux-rpc-consumer-closure-20261023/repo', 'b-consumer-c08532b2', 'linux-rpc-consumer-closure',
                    '673601e54f8fdcf2ea72d239c87d92b483ff231b', 'c08532b28238a24f517db1beb3b12614abd05a6c',
                    '1a6559a7 70c6c2b8 03d504f4 6db741fb 502a93ee 675a1a17 d2965749 98206e64 c08532b2',
                    '673601e5 preserved in 7422efe6 (frozen-1339 b-launch, commits[26]); SOURCE-ONLY DERIVATIVE (compiled bundles + manifests held at 673601e5)',
                    exclude=BUNDLES + MANIFESTS, hold='673601e54f8fdcf2ea72d239c87d92b483ff231b'),
    # frozen-1852 content-check (rc 1): REPORT.md names an existing outputs directory whose name carries the LOWERCASE rewritten
    # literal; the 2026-10-21 rewrite removed both cases, so the report is omitted (blob recorded) rather than published
    'guest-lineage': R(W / 'resource-guest-lineage-20261023/repo', 'guest-lineage-02863ae1', 'lineage', None,
                       '02863ae1e0e41167d6abfa7d7b31871d3387cc5a', '02863ae1', 'root commit (R lineage report repo); SOURCE-ONLY DERIVATIVE (REPORT.md omitted)',
                       exclude=('REPORT.md',)),
}
BO, MO = '../linux-rpc-consumer-closure-20261023/', '../custody-v2-durability-20261023/'
FROZEN = ([BO + 'RESULT.md', BO + 'handoff/HANDOFFS.md', MO + 'RESULT.md']
          + ['source-preservation/' + n for n in ('RESULT-frozen-1806-checkpoint.md', 'snapshots-1852/ROOT-PENDING-LATEST.snapshot-1852.txt',
             'snapshots-1852/ROOT-CONTINUE-LATEST.snapshot-1852.txt', 'snapshots-1852/effective-goal-requirements.snapshot-1852.txt')])
ROOT_EVIDENCE = ['../../outputs/decentralization-audit/' + n for n in ('nucbox-cpu-enforcement-counterexample-20261023.json',
                                                                      'custody-v2-live-verification-20261023.md')]


import atexit
_ATTR = tempfile.NamedTemporaryFile('w', suffix='.attributes', delete=False); _ATTR.write('* diff=nofunc1852\n'); _ATTR.close(); atexit.register(os.unlink, _ATTR.name)
NOFUNC = ('-c', f'core.attributesFile={_ATTR.name}', '-c', 'diff.nofunc1852.xfuncname=^$')


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
assert sides['root-cpu-quota']['headTree'] == '56f0e35c1634abc562a3770db2fc06c2612c74c6' and sides['custody-live']['headTree'] == 'b48a5ff5963de710ba4f550ffec8fc6d121f1525'
assert sides['m-durability']['headTree'] == 'c1366cf9c52b7381ef9d308f9ec8aa6be3145efd'
F1806 = json.loads((sp / 'frozen-1806-export/INVENTORY.json').read_text())
assert F1806['sides']['root-cpu-build']['head'] == sides['root-cpu-quota']['base']
# no committed executable/archive/wasm anywhere (the ignored *.exe/*.bin/*.wasm/raw quote are never read)
assert not [f['path'] for s in sides.values() for f in s['changedFiles'] if f['path'].endswith(('.exe', '.bin', '.wasm', '.zip', '.dll', '.pdb'))]
# ---- m-durability: touched-file reproduction ------------------------------------------------------------------------------
m, MR = sides['m-durability'], SIDES['m-durability']['repo']
touched = sorted({f['path'] for f in m['changedFiles']})
bf = out / SIDES['m-durability']['name'] / 'base-files'
m['baseFiles'] = []
for p in touched:
    ls = git(MR, 'ls-tree', m['base'], '--', p).split()
    if not ls: continue
    data = git(MR, 'cat-file', 'blob', ls[2], text=False); data.decode('utf-8'); assert OLD not in data and OLD.lower() not in data, p
    (bf / p).parent.mkdir(parents=True, exist_ok=True); (bf / p).write_bytes(data)
    m['baseFiles'].append({'path': p, 'mode': ls[0], 'blob': ls[2], 'file': str((bf / p).relative_to(out)), 'sha256': sha(data)})
for c in m['commits']:
    c['touchedBlobs'] = {p: (git(MR, 'ls-tree', c['commit'], '--', p).split() or [None, None, None])[2] for p in touched}
m['baseTreeNotReproduced'] = {'base': m['base'], 'baseTree': git(MR, 'rev-parse', m['base'] + '^{tree}').strip(),
    'why': ('custody-release repo-b quote-tested candidate on pre-rewrite history: not in any pushed checkpoint material, and its tree has '
            f"{len(git(MR, 'grep', '-l', '-i', OLD.decode(), m['base']).splitlines())} files containing the rewritten literal (case-insensitive), "
            'so it cannot be published; its parent e762a9c5 corresponds to rewritten b97ffbc5 in the checkpoint repository history'),
    'verified': 'base-files/ + this side\'s patches reproduce every touched path\'s blob at every commit (verify-frozen-1852-export.py)'}
m['note'] = ('M custody v2 durability, initial frozen fix: ed0c536d extracts the sealed-state writer (no behaviour change); 415483ff adds the '
             'persist-before-ack barrier for member shares, approvals and acks + test. SOURCE ONLY: not built, imaged or measured; M\'s RESULT.md '
             'records an e2e constructor fixture failure. The dirty phase-2 follow-up (3ccd4333, 0a6b108e and worktree) is NOT captured')
sides['root-cpu-quota']['note'] = ('ROOT: actual Windows read-only policy/scheduler reads and 3 native CPU canaries. RESULT = FAILURE of the Hyper-V cap: '
             'the Windows 11 root scheduler (0x4) ignores WMI caps, a 1% share still consumed a full guest CPU. Above-one-CPU guest quota and '
             'parallel execution passed. The new B source fix is pending; NO CPU production activation. Binaries (*.exe/*.bin/*.wasm) ignored, not captured')
sides['custody-live']['note'] = ('ROOT fresh read-only custody v2 verification: 2-RPC known state, delta event discovery, signed-nonce AMD quote verdict, local '
             'runtime image hashes. No secrets/private keys read; the original single-seat bootstrap is confirmed (NOT decentralized); no secret '
             'lifecycle or rollout; address book unset; metal0 accepted/pending owner zero. The raw quote file (raw chip ID) and node_modules are '
             'ignored/untracked and were never read or captured')
# ---- b-consumer derivative --------------------------------------------------------------------------------------------------
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
b, BR = derivs['b-consumer'], DERIVS['b-consumer']['repo']
assert b['originalHeadTree'] == 'b578d56b81b16deeb62c239a4dab049a0c982ead', 'B head tree'
conv = out / DERIVS['b-consumer']['name'] / 'converted'; conv.mkdir(parents=True, exist_ok=True)
b['convertedManifests'] = []
for mp in MANIFESTS:
    raw = git(BR, 'show', f"{b['head']}:{mp}"); mm = json.loads(raw); keys = list(mm)
    stem = Path(mp).name[:-len('.manifest.json')]
    sums = ''.join(f'{v}  {kk}\n' for kk, v in mm['inputs'].items()); meta = {kk: v for kk, v in mm.items() if kk != 'inputs'}
    (conv / f'{stem}.inputs.sha256sums').write_text(sums); (conv / f'{stem}.meta.json').write_text(json.dumps(meta, indent=2) + '\n')
    assert json.dumps({kk: (dict(reversed(l.split('  ', 1)) for l in sums.splitlines()) if kk == 'inputs' else meta[kk]) for kk in keys}, indent=2) + '\n' == raw, mp
    b['convertedManifests'].append({'path': mp, 'sha256': sha(raw.encode()), 'keys': keys,
        'files': [{'file': str((conv / n).relative_to(out)), 'sha256': sha((conv / n).read_bytes())} for n in (f'{stem}.inputs.sha256sums', f'{stem}.meta.json')],
        'rebuild': "json.dumps({k: meta[k] for k in keys} with inputs = dict((p, h) for each line 'h  p' in order), indent=2) + '\\n' (Python) == the committed manifest (asserted)"})
b['omittedRecipe'] = ('The compiled guest bundles were rebuilt by B in 502a93ee ("existing builders, unchanged settings"); restore them by running the '
                      'repository\'s own bundle builders at c08532b2 with B\'s node_modules (the platform-api builder also needs the gitignored '
                      'relay/network-runtime.bundle.mjs), and compare with omittedAtHead sha256 and the converted manifests. D did NOT rebuild them; '
                      'no rebuild claim. The small lease-gas-conduit bundle is exported as committed text; only its manifest is converted')
b['label'] = ('SOURCE-ONLY DERIVATIVE continuing frozen-1339 b-launch: everything B changed is exported except the compiled platform-api (8.9 MB, '
              'over the 5 MB limit) and mcp-server bundles (held at 673601e5 bytes) and the three bundle manifests (held; published converted). '
              'Source/test only; NOT production provider independence (root)')
g = derivs['guest-lineage']
assert g['originalHeadTree'] == 'bb656d87395fbb21cdb4382c5bdbcb89a0e56d95', 'R lineage head tree'
g['label'] = ('SOURCE-ONLY DERIVATIVE: R frozen lineage report/source evidence (production guest 5fbfb947: binaries from clean c85e0c592, '
              'rewritten eac520ae2; minimal-delta monitor recipe, evidence) minus REPORT.md')
g['omittedRecipe'] = ('REPORT.md (blob/sha256 in omittedAtHead) references an existing outputs directory whose NAME carries the lowercase '
                      'rewritten provider literal (file names were not changed by the 2026-10-21 rewrite); it is not published here. Restore '
                      'it from R\'s repository work/resource-guest-lineage-20261023/repo at 02863ae1; nothing else differs')
b['resultCommitNotCaptured'] = git(BR, 'log', '-1', '--format=%H %s', 'linux-rpc-consumer-closure-result')
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
inventory = {'format': 'enclave-frozen-1852-export/v1', 'checkpointHeadAtExport': CHECKPOINT_HEAD,
    'batch': '1852 = the batch start 2026-10-23T18:52Z (date -u): an identifier, not a publication time',
    'label': ('SOURCE + EVIDENCE ONLY; not production completion. ROOT native CPU quota COUNTEREXAMPLE 8afbf879 (the Hyper-V cap FAILED under the '
              'Windows root scheduler; no CPU activation; source fix pending), ROOT fresh read-only custody v2 verification a90f8339 (single-seat '
              'bootstrap, not decentralized), R guest lineage 02863ae1, B Linux RPC consumer closure c08532b2 (source/test only, derivative), M '
              'custody v2 durability 415483ff (source only; touched-file reproduction).'),
    'sides': sides, 'derivatives': derivs, 'lowercaseRewrittenLiteral': lit, 'frozenSources': frozen, 'rootEvidence': evidence,
    'evidenceVsSource': 'Committed logs, receipts, run outputs and RESULT files inside these repositories are EVIDENCE; the rest is source.',
    'notPreserved': ['ignored/untracked files in every repo: root-validation *.exe/*.bin/*.wasm, custody-live evidence/fresh-quote-raw.json (raw chip ID) and node_modules',
                     'B compiled platform-api + mcp-server bundles (held) and B result commit ' + b['resultCommitNotCaptured'][:9] + ' (duplicate exports; its RESULT/HANDOFFS are captured from the outer directory)',
                     'M phase-2 follow-up (commits after 415483ff, worktree changes, RESULT-FOLLOWUP.md, patches), M base c635fd68 full tree',
                     'active Q build / A2 guest / debug artifacts, B cpu-root-scheduler-quota, R custody dashboard, M durability follow-up, every other active tree']}
(out / 'INVENTORY.json').write_text(json.dumps(inventory, indent=1) + '\n')
print(json.dumps({k: {'commits': len(v['commits']), 'files': len(v['changedFiles'])} for k, v in {**sides, **derivs}.items()}
                 | {'frozen': len(frozen), 'rootEvidence': len(evidence), 'literalFiles': len(lit), 'inventorySha256': sha((out / 'INVENTORY.json').read_bytes())}))

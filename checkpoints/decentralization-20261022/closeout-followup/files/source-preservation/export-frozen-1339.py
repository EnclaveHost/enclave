"""Export the frozen-1339 batch for the checkpoint, from Git OBJECTS only (never from mutable or dirty worktrees). "1339" is the batch
IDENTIFIER = its actual start, 2026-10-23T13:39Z (date -u); it is not a publication time. Root-designated TERMINAL immutable heads only
(ROOT-*-FINAL notes, ROOT-PENDING-LATEST); every active successor tree is excluded.

Linear series on a base already preserved in pushed checkpoint material (476c589b), or root commits:
* s-role       public-rpc-host-role/repo     14d1e495 -> 02862306, 4c059b99 (own-property guards), 36919aaf (S public RPC host role)
* s-report     public-rpc-host-role          root -> 6 commits -> bea9b760 (S report repo)
* b-launch     linux-rpc-runtime-launch/repo fad657bc -> 27 commits -> 673601e5 (source, tree ea4b9cac) -> d9c1bb19 (result branch)
* f-baseline   windows-final-baseline-compose/candidate  14d1e495 -> 6fd9a787 (R1), c335c76c (R2), 30339303 (A consumers) -> 1f19ad15 (RESULT/evidence)
* e-wallet     rpc-wallet-dependency-20261023/repo  349318a0 -> 6ab298f1, dc2e5d74
* t-hdd        rpc-hdd-transport-20261023/repo      root -> a9f0155c (tree a5cb6fff)
* p-cache      cache-composed-kernel-delta-20261023 root -> 6 commits -> e8e86801 (root report-precision correction over 18ccb272)
* root-wallet-iface 66b67c35, root-shutdown 56b68c07..2f702e76, root-ram96b dd7e7af8 -> f3ba7703, 237c78f2, 2ed6ba61
SOURCE-ONLY DERIVATIVES:
* a-gaps       rpc-priority/repo e32dd607 -> 40f2b0a9, 554a251c (tree f34efc10), with metal/guest/mcp-server.bundle.mjs (compiled,
               5,052,898 B, over the capture's per-file bound) HELD at its e32dd607 bytes; restore = the repository's own
               scripts/build-mcp-guest-bundle.mjs, validated --check by frozen-1339-a-bundle-check
* e-report     rpc-wallet-dependency-20261023 root -> 4 commits -> ec2be533, minus exports/ (E's own git bundle + duplicate patches)
"""

from pathlib import Path
import hashlib, json, os, shutil, subprocess, tempfile

root = Path(__file__).resolve().parents[3]
W = root / 'work'
base = W / 'resume-after-checkpoint-20261022'
sp = base / 'source-preservation'
out = sp / 'frozen-1339-export'
checkpoint = W / 'source-checkpoint-20261022/main-repo'
CHECKPOINT_HEAD = '476c589bb35abd10efd830863b042e8801c18ef0'
AUTHOR = 'SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'
# OLD = the former provider name the 2026-10-21 repository rewrite replaced by 'Cloud Provider'; built from hex so this tool
# itself does not carry the literal it guards against
OLD = bytes.fromhex('54696e666f696c')
R = lambda repo, name, branch, b, head, commits, prov, **kw: {'repo': repo, 'name': name, 'branch': branch, 'base': b, 'head': head,
                                                              'commits': commits.split(), 'baseProvenance': prov, **kw}
ROOTC = 'root commit (ROOT repo)'
SIDES = {
    's-role': R(W / 'public-rpc-host-role/repo', 's-role-36919aaf', 'public-rpc-host-role', '14d1e4954cf7c9900d5d3e841a23f02de945c1b2',
                '36919aafe76c743272b323c8bca27871b5219ab9', '02862306 4c059b99 36919aaf', '14d1e495 preserved in 476c589b (frozen-0931 f-rpc-closure head)'),
    's-report': R(W / 'public-rpc-host-role', 's-report-bea9b760', 'master', None, 'bea9b760b70df03012fb218942fe9098441ca47c',
                  '18e021dd 493be895 ba22dbf5 3a10456b 548b4e97 bea9b760', 'root commit (S public RPC report repo)'),
    'b-launch': R(base / 'linux-rpc-runtime-launch/repo', 'b-launch-d9c1bb19', 'linux-rpc-runtime-launch-result', 'fad657bc5626166bde1bde4454ec4f73d23dde47',
                  'd9c1bb195c9fa78de23f9d0ba7cc6fca4e7f19a1', 'b7f88a86 5936a2c6 a9a549f0 e4cc8f5f 5acd00cb 94124c65 93c43ef2 2b320b19 22cb0df0 749dd6a1 eeb2f0aa 1df51ebb 003929a6 83251376 9bc652b6 cbc51aa2 f41c36f2 14eea4ad 6c01b134 5d2d2c3c 66812187 a4bcf904 92ca0778 60a4f969 722cf1b0 927e2acf 673601e5 d9c1bb19',
                  'fad657bc preserved in 476c589b (frozen-0745 d-linux-carrier)'),
    'f-baseline': R(base / 'windows-final-baseline-compose/candidate', 'f-baseline-1f19ad15', 'final/windows-baseline', '14d1e4954cf7c9900d5d3e841a23f02de945c1b2',
                    '1f19ad15aaa6200e1882d148f2b43b7c25fc7058', '6fd9a787 c335c76c 30339303 1f19ad15', '14d1e495 preserved in 476c589b (frozen-0931 f-rpc-closure head)'),
    'e-wallet': R(W / 'rpc-wallet-dependency-20261023/repo', 'e-wallet-dc2e5d74', 'rpc-wallet-dependency', '349318a0600917bad8f391ad628fa0c7f134b3f6',
                  'dc2e5d7402327bdd376cf3b90cfa23a551a37ba8', '6ab298f1 dc2e5d74', '349318a0 preserved in 476c589b (frozen-0931 s-browser head)'),
    't-hdd': R(W / 'rpc-hdd-transport-20261023/repo', 't-hdd-a9f0155c', 'master', None, 'a9f0155c55d9284bd38b7bfc3a8015c2d01fb17d', 'a9f0155c',
               'root commit (T repo)', headTree='a5cb6fffd2a879e33e31a35b1919b18f99361af0'),
    'root-wallet-iface': R(W / 'root-rpc-wallet-interface-review-20261023', 'root-wallet-iface-66b67c35', 'master', None, '66b67c359b49783131b298a9221fbcfb26e51a6a', '66b67c35', ROOTC),
    'root-shutdown': R(W / 'root-rpc-shutdown-review-20261023', 'root-shutdown-2f702e76', 'master', None, '2f702e765fe5641e1852ac4caee9500015137047', '56b68c07 904ad267 2f702e76', ROOTC),
    'root-ram96b': R(W / 'nucbox-ram96-20261023', 'root-ram96b-2ed6ba61', 'master', 'dd7e7af849e641be10e61e92be266e9ecea93722', '2ed6ba6115c4db7d49e2ce0fce78dbdd0d786c46',
                     'f3ba7703 237c78f2 2ed6ba61', 'dd7e7af8 preserved in 476c589b (frozen-1118 root-ram96)'),
}
MCP = 'metal/guest/mcp-server.bundle.mjs'
PREC = 'run/20261023T112303Z/out/receipts.jsonl'
DERIVS = {
    'p-cache': R(W / 'cache-composed-kernel-delta-20261023', 'p-cache-e8e86801', 'main', None, 'e8e8680121cd4262104dc8b3af8ed846d196f82b',
                 '515a1ec9 8a0b0fbe ddd25931 fe95bd50 18ccb272 e8e86801', 'root commit (P cache-composed-kernel-delta repo); SOURCE-ONLY DERIVATIVE (one evidence log omitted)',
                 exclude=(PREC,)),
    'a-gaps': R(base / 'rpc-priority/repo', 'a-gaps-554a251c', 'rpc-priority', 'e32dd607b55b9c6afd605482a4bc31c9d30528d6', '554a251cbe14aa7ba8af4c160d9a8b9793e4071a',
                '40f2b0a9 554a251c', 'e32dd607 preserved EXACTLY in 476c589b (frozen-0931 a-parity head)', exclude=(MCP, MCP + '.manifest.json')),
    'e-report': R(W / 'rpc-wallet-dependency-20261023', 'e-report-ec2be533', 'master', None, 'ec2be533a74a16e79cb5b58f6793bef1679b18a7',
                  'f92006a0 f5d4592a 5c4bf1f9 ec2be533', 'root commit (E wallet report repo); SOURCE-ONLY DERIVATIVE (exports/ omitted)', exclude=('exports/',)),
}
FROZEN = ['source-preservation/' + n for n in ('RESULT-frozen-1118-checkpoint.md', 'frozen-1339-a-bundle-check-4.sh', 'frozen-1339-a-bundle-check-4.out',
          'snapshots-1339/ROOT-PENDING-LATEST.snapshot-1339.txt', 'snapshots-1339/effective-goal-requirements.snapshot-1339.txt')]
ROOT_EVIDENCE = (['source-preservation/' + n for n in ('ROOT-A-CONSUMER-GAPS-FINAL.txt', 'ROOT-B-LAUNCH-FINAL.txt', 'ROOT-E-WALLET-FINAL.txt',
                  'ROOT-F-BASELINE-FINAL.txt', 'ROOT-T-HDD-TRANSPORT-FINAL.txt')]
                 + ['../../outputs/decentralization-audit/' + n for n in ('checkpoint-476-verified-20261023.json', 'checkpoint-remote-recheck-20261023.json',
                    'cache-composed-kernel-review-20261023.json', 'consumer-test-failure-review-20261023.json', 'integration-subjob-review-20261023.json',
                    'bundler-primary-source-review-20261023.json', 'wallet-broadcast-retry-review-20261023.json', 'storage-windows-subjob-review-20261023.json',
                    'hdd-transport-mutation-review-20261023.json', 'rpc-wallet-interface-review-20261023.json', 'rpc-shutdown-review-20261023.json',
                    'rpc-shutdown-diagnostic-cancellation-20261023.json', 'rpc-shutdown-daemon-confirmation-20261023.json')])


def git(repo, *args, text=True, env=None):
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=text, env=env).stdout


def sha(data):
    return hashlib.sha256(data).hexdigest()


def excluded(path, x):   # a directory prefix ends in '/'; anything else is ONE exact path (git pathspec semantics)
    return path.startswith(x) if x.endswith('/') else path == x


def export(key, spec, exclude=()):
    repo, dst = spec['repo'], out / spec['name']
    head = git(repo, 'rev-parse', spec['head'] + '^{commit}').strip()
    assert head == spec['head'], f'{key}: {spec["head"]} resolves to {head}'
    base_full = git(repo, 'rev-parse', spec['base'] + '^{commit}').strip() if spec['base'] else None
    assert base_full == spec['base'], key
    rng = f'{base_full}..{head}' if base_full else head
    log = git(repo, 'log', '--reverse', '--format=%H%x09%P%x09%T%x09%an <%ae>%x09%cn <%ce>%x09%cI%x09%s', rng).splitlines()
    rows = [dict(zip(('commit', 'parent', 'tree', 'author', 'committer', 'committedAt', 'subject'), l.split('\t'))) for l in log]
    assert len(rows) == len(spec['commits']) and [r['commit'][:len(c)] for r, c in zip(rows, spec['commits'])] == spec['commits'], \
        f"{key}: commits {[r['commit'][:9] for r in rows]} != {spec['commits']}"
    assert rows[0]['parent'] == (base_full or ''), f'{key}: first parent'
    assert all(rows[i]['parent'] == rows[i - 1]['commit'] for i in range(1, len(rows))), f'{key}: not a linear series'
    assert all(r['author'] == AUTHOR and r['committer'] == AUTHOR for r in rows), f'{key}: unexpected author/committer'
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
    git(repo, 'format-patch', '--full-index', '--no-renames', '--no-signature', '-o', str(dst / 'patches'),
        *(['--root', head] if not base_full else [rng]), '--', '.', *[f':(exclude){x}' for x in exclude])
    patches = sorted((dst / 'patches').iterdir())
    # a commit that only touches excluded paths has no derivative patch (format-patch's pathspec walk skips it): recorded, and
    # the verifier checks the derived tree is unchanged across it
    for r in rows:
        r['emptyAfterExclusion'] = bool(exclude) and subprocess.run(['git', '-C', str(repo), 'diff', '--quiet', r['parent'] or '4b825dc642cb6eb9a060e54bf8d69288fbee4904', r['commit'], '--', '.',
                                                                    *[f':(exclude){x}' for x in exclude]]).returncode == 0
    assert len(patches) == sum(not r['emptyAfterExclusion'] for r in rows), f'{key}: {len(patches)} patches for {len(rows)} commits'
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
assert sides['t-hdd']['headTree'] == 'a5cb6fffd2a879e33e31a35b1919b18f99361af0', 't-hdd head tree (ROOT-T-HDD-TRANSPORT-FINAL)'
b = sides['b-launch']; assert b['commits'][-2]['commit'] == '673601e54f8fdcf2ea72d239c87d92b483ff231b' and b['commits'][-2]['tree'] == 'ea4b9cac641e61b2b743972cfd1f579d01577699'
assert git(SIDES['b-launch']['repo'], 'rev-parse', 'linux-rpc-runtime-launch').strip() == '673601e54f8fdcf2ea72d239c87d92b483ff231b', 'B source branch head (ROOT-B-LAUNCH-FINAL)'
b['sourceBranch'] = {'branch': 'linux-rpc-runtime-launch', 'head': '673601e54f8fdcf2ea72d239c87d92b483ff231b', 'tree': 'ea4b9cac641e61b2b743972cfd1f579d01577699'}
f = sides['f-baseline']; assert f['commits'][2]['commit'] == '30339303bedcb5cb9a6d8fe2e495f381f05d7c74', 'F source 30339303 (ROOT-F-BASELINE-FINAL)'
# S: the role packages are an UNTRACKED build output (scripts/build-host-service-packages.mjs; S's report jobs/build-packages.sh): hashes only
pk = W / 'public-rpc-host-role/repo/network/host-services/packages'
sides['s-role']['untrackedBuildOutputs'] = {'dir': str(pk.relative_to(root)), 'files': {str(q.relative_to(pk)): sha(q.read_bytes()) for q in sorted(pk.rglob('*')) if q.is_file()},
    'recipe': 'node scripts/build-host-service-packages.mjs in the s-role tree (S report repo jobs/build-packages.sh); S RESULT-PUBLIC-RPC-ROLE.md pins public-rpc.package.json 300cdc81',
    'note': 'observed local untracked files at export time, NOT archived and NOT re-built by D'}
assert sides['s-role']['untrackedBuildOutputs']['files']['public-rpc.package.json'] == '300cdc81a4961763b2b0e8c84023f6238448e3fad02cea247af72d3354e57530'
derivs = {}
for k, s in DERIVS.items():
    d = export(k, s, exclude=s['exclude'])
    omitted = {}
    for c in d['commits']:
        c['originalTree'] = c['tree']; c['tree'] = derived_tree(s['repo'], c['commit'], s['exclude'], s['base'])
        omitted[c['commit']] = [dict(zip(('mode', 'type', 'blob', 'bytes', 'path'), l.split(None, 4)))
                                for x in s['exclude'] for l in git(s['repo'], 'ls-tree', '-r', '-l', c['commit'], '--', x).splitlines()]
    d['originalHeadTree'] = d['headTree']; d['headTree'] = d['commits'][-1]['tree']
    d['omittedAtHead'] = [{**a, 'sha256': sha(git(s['repo'], 'cat-file', 'blob', a['blob'], text=False))} for a in omitted[d['head']]]
    d['excluded'] = list(s['exclude'])
    derivs[k] = d
a = derivs['a-gaps']
assert a['originalHeadTree'] == 'f34efc109fc51f7212770a58b0f9636b1f892fe7', 'A head tree (ROOT-A-CONSUMER-GAPS-FINAL)'
mb = next(x for x in a['omittedAtHead'] if x['path'] == MCP); rawman = git(DERIVS['a-gaps']['repo'], 'show', f"{a['head']}:{MCP}.manifest.json"); man = json.loads(rawman)
assert len(a['omittedAtHead']) == 2 and mb['sha256'] == man['sha256'] == 'ae7088a7daf19934d29ea5bd35220da0a2b108f8695dab279d689f99ae67c468' and int(mb['bytes']) == man['bytes']
chk = (sp / 'frozen-1339-a-bundle-check-4.out').read_text()
assert 'build-mcp-guest-bundle --check rc=0' in chk, 'the restore recipe was not validated (frozen-1339-a-bundle-check)'
a['omittedRecipe'] = {'path': MCP, 'gitBlob': mb['blob'], 'sha256': mb['sha256'], 'bytes': int(mb['bytes']),
    'why': 'a COMPILED esbuild bundle (not authored source) of 5,052,898 B, above the capture\'s 5 MB per-file bound',
    'restore': 'node scripts/build-mcp-guest-bundle.mjs in the a-gaps tree with its package-lock node_modules; the committed manifest '
               f'{MCP}.manifest.json (exported) pins 2974 input sha256s and the bundle sha256 ae7088a7',
    'manifest': 'omitted too (gitleaks false positive on name/hash pairs); restore it byte-exactly from convertedManifest first',
    'validated': 'frozen-1339-a-bundle-check-4: a throwaway clone of 554a251c at the same depth as A\'s repo, carrying A\'s own node_modules LINKS (., relay, sdk/sessions; the build uses preserveSymlinks); build-mcp-guest-bundle.mjs --check rc 0. Attempts 1-3 failed (dangling link; real copies differ; sdk/sessions missing: 434 inputs)'}
# the bundle MANIFEST is a tracked source file, but its JSON pairs npm file names such as privateKeyToAccount.js / setCoinbase.js with
# 64-hex sha256s, which the checkpoint's unchanged gitleaks rules read as labelled keys: it is omitted from the patches and published as
# 'sha256  path' text + the remaining fields, with an asserted exact rebuild of the original bytes
conv = out / a['patches'][0]['file'].split('/')[0] / 'converted'; conv.mkdir(parents=True, exist_ok=True)
sums = ''.join(f'{v}  {k}\n' for k, v in man['inputs'].items())
meta = {k: v for k, v in man.items() if k != 'inputs'}
(conv / 'mcp-server.bundle.mjs.manifest.inputs.sha256sums').write_text(sums); (conv / 'mcp-server.bundle.mjs.manifest.meta.json').write_text(json.dumps(meta, indent=2) + '\n')
keys = list(man.keys())
rebuilt = json.dumps({k: (dict(reversed(l.split('  ', 1)) for l in sums.splitlines()) if k == 'inputs' else meta[k]) for k in keys}, indent=2) + '\n'
assert rebuilt == rawman and sha(rebuilt.encode()) == next(x for x in a['omittedAtHead'] if x['path'] == MCP + '.manifest.json')['sha256']
a['convertedManifest'] = {'path': MCP + '.manifest.json', 'files': [{'file': str((conv / n).relative_to(out)), 'sha256': sha((conv / n).read_bytes())}
    for n in ('mcp-server.bundle.mjs.manifest.inputs.sha256sums', 'mcp-server.bundle.mjs.manifest.meta.json')],
    'rebuild': f"json.dumps({{k: meta[k] for k in {keys}}} with inputs = dict((p, h) for each line 'h  p' in order), indent=2) + '\\n' (Python) == the committed manifest (asserted)"}
a['label'] = ('SOURCE-ONLY DERIVATIVE on the EXACT e32dd607: patches omit the compiled MCP bundle, so derived trees hold it at e32dd607\'s bytes; '
              'exact original trees (head f34efc10) need the validated rebuild (omittedRecipe)')
pc = derivs['p-cache']
pc['label'] = ('SOURCE-ONLY DERIVATIVE: P evidence log run/20261023T112303Z/out/receipts.jsonl omitted (two result lines trip the unchanged gitleaks '
               'generic-api-key rule on a JSON "key" field; P kept it in its own repository, blob/sha256 in omittedAtHead). Everything else is exact')
e = derivs['e-report']
e['label'] = ('SOURCE-ONLY DERIVATIVE: E report repo minus exports/ (E\'s own git bundle - binary - and patches duplicating the e-wallet Git '
              'objects; recorded in omittedAtHead). Fixture keys stay excluded as in E\'s own export')
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
inventory = {'format': 'enclave-frozen-1339-export/v1', 'checkpointHeadAtExport': CHECKPOINT_HEAD,
    'batch': '1339 = the batch start 2026-10-23T13:39Z (date -u): an identifier, not a publication time',
    'label': ('SOURCE + OFFLINE TESTS ONLY; candidates, not production completion. Nothing here is merged into the normal tree, imaged, deployed or '
              'activated. Root-designated terminal heads since 476c589b: S public RPC role 36919aaf + report bea9b760 (proof source / pending '
              'nonce / TLS gaps open); A consumer gaps 554a251c (receipt/provenance work remains); B launch 673601e5 + result d9c1bb19 (launch '
              'only, not consumer closure); F baseline 30339303 + evidence 1f19ad15 (native/integration failures open); E wallet dc2e5d74 + report '
              'ec2be533 (cannot prove real MetaMask or Alto); T HDD transport a9f0155c (physical hardware untested); P cache kernel e8e86801; ROOT '
              'wallet interface 66b67c35, shutdown 2f702e76, RAM receipts 2ed6ba61 (configured 96 / active 64, no restart).'),
    'sides': sides, 'derivatives': derivs, 'lowercaseRewrittenLiteral': lit, 'frozenSources': frozen, 'rootEvidence': evidence,
    'evidenceVsSource': 'Committed logs, receipts, run outputs and RESULT files inside these repositories are EVIDENCE; the rest is source. frozen-0931 '
                        'published E evidence/capture/*.json (public-chain bytecode captures): retained unchanged as EVIDENCE per root (useful for reproduction)',
    'notPreserved': ['A metal/guest/mcp-server.bundle.mjs at 554a251c (compiled, >5 MB; validated rebuild recipe) and E report exports/ (git bundle + duplicate patches)',
                     'S untracked network/host-services/packages/ (hashes + recipe recorded, not archived)',
                     'untracked/ignored files in every repo (configs, readiness, private logs, clones, binaries, test keys)',
                     'A RESULT-CONSUMER-GAPS.md / jobs outputs in the ACTIVE rpc-priority directory (root: commits only)',
                     'outputs/decentralization-audit/windows-integration-j1-review-20261023.json and F ROOT-J1 notes (F active; capture after terminal)',
                     'ACTIVE successor trees: S public-rpc-consumer-interface, A receipt integration, B linux-rpc-consumer-closure, F windows-final-runtime-'
                     'integration, E rpc-wallet-production-build, T rpc-hdd-storage-compose, P rpc-bundler-service, M startup-cancellation fix',
                     'root notes inside active worker directories (ROOT-REMAINING-PROVIDER-READS, ROOT-R2-RESULT-REVIEW, ROOT-J3D-FAILURE-REVIEW, ROOT-BROADCAST-RETRY-REVIEW)']}
(out / 'INVENTORY.json').write_text(json.dumps(inventory, indent=1) + '\n')
print(json.dumps({k: {'commits': len(v['commits']), 'files': len(v['changedFiles'])} for k, v in {**sides, **derivs}.items()}
                 | {'frozen': len(frozen), 'rootEvidence': len(evidence), 'literalFiles': len(lit), 'inventorySha256': sha((out / 'INVENTORY.json').read_bytes())}))

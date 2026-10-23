"""Export the frozen-1517 batch for the checkpoint, from Git OBJECTS only (never from mutable or dirty worktrees). "1517" is the batch
IDENTIFIER = its actual start, 2026-10-23T15:17Z (date -u); it is not a publication time. Root-designated terminal immutable heads only;
active successor trees are excluded.

First-parent series on a base already preserved in pushed checkpoint material (4aaba75b), or root commits:
* e-prod        rpc-wallet-production-build-20261023/repo dc2e5d74 -> e078490d (MERGE of published main 68b82926, one diff vs first
                parent) -> ae00cd96 (tree 51591856)
* f-runtime-gap windows-feature-gap-repair-20261023/candidate 1f19ad15 -> 896c5d49 .. 0de09415 (F runtime source, tree 5cbdb670),
                dda47a35 (evidence; = HEAD of windows-final-runtime-integration-20261023/candidate) -> 0ed6b6d9 (gap repair, tree dfb63eaf)
* m-cancel      privacy-startup-cancellation-20261023/repo 4c059b99 -> 1c386e23, 808f36c5, 3746e4fc
* s-iface       public-rpc-consumer-interface-20261023/repo 36919aaf -> 4f7632d7 (tree b246ba51); s-iface-report root -> a32d209e
* c-shard       storage-shard-recovery root -> 5c9717fc .. 5c317531 (e99498e9 fix, 9eb65336 fence test, fixture/report)
* t-compose / ts-compose: rpc-hdd-storage-compose t a9f0155c -> 4bb72315, s 92b71784 -> fb9ce4a7; t-report root -> be3392d2
* e-prod-report root -> 3d47052b, 4beedc5b (minus exports/: E's git bundle + duplicate patches) [derivative]
* root-api-mcp  api-mcp-recovery-20261023 root -> 95ee73dc
SOURCE-ONLY DERIVATIVES:
* a-receipts    rpc-priority/repo-receipts 554a251c (frozen-1339 a-gaps DERIVATIVE head) -> 1d829457, cdcbdf59, 23fa880a, eab4cfac
                (tree e0e07f21): metal/guest/mcp-server.bundle.mjs (compiled, >5 MB) and its manifest held at e32dd607 bytes as in a-gaps;
                manifest published converted; the bundle rebuild validated by frozen-1517-a-bundle-check (gated on its actual rc)
* tp-compose    rpc-hdd-storage-compose p f8c999ed (frozen-1118 p-compose DERIVATIVE head) -> 1db4d408, ed814e58, same 5 exclusions
* e-prod-report (above)
"""
from pathlib import Path
import hashlib, json, os, shutil, subprocess, tempfile

root = Path(__file__).resolve().parents[3]
W = root / 'work'
base = W / 'resume-after-checkpoint-20261022'
sp = base / 'source-preservation'
out = sp / 'frozen-1517-export'
checkpoint = W / 'source-checkpoint-20261022/main-repo'
CHECKPOINT_HEAD = '4aaba75beee896bfd4a042d9f848f820d54925c7'
AUTHOR = 'SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'
# OLD = the former provider name the 2026-10-21 repository rewrite replaced by 'Cloud Provider'; built from hex so this tool
# itself does not carry the literal it guards against
OLD = bytes.fromhex('54696e666f696c')
R = lambda repo, name, branch, b, head, commits, prov, **kw: {'repo': repo, 'name': name, 'branch': branch, 'base': b, 'head': head,
                                                              'commits': commits.split(), 'baseProvenance': prov, **kw}
ROOTC = 'root commit (ROOT repo)'
H = W / 'rpc-hdd-storage-compose-20261023'
SIDES = {
    'e-prod': R(W / 'rpc-wallet-production-build-20261023/repo', 'e-prod-ae00cd96', 'rpc-wallet-production-build', 'dc2e5d7402327bdd376cf3b90cfa23a551a37ba8',
                'ae00cd9659e46e3dffe5407bdf34442416a9e69a', 'e078490d ae00cd96', 'dc2e5d74 preserved in 4aaba75b (frozen-1339 e-wallet head)',
                merges=('e078490da6e3483016a891415de4db5e85109aa6',)),
    'm-cancel': R(W / 'privacy-startup-cancellation-20261023/repo', 'm-cancel-3746e4fc', 'privacy-startup-cancellation', '4c059b997360483c743deca343c2e42b1b534eeb',
                  '3746e4fcbc163a743fbd1fb35a989e8ca0763b7c', '1c386e23 808f36c5 3746e4fc', '4c059b99 preserved in 4aaba75b (frozen-1339 s-role, 2nd commit)'),
    's-iface': R(W / 'public-rpc-consumer-interface-20261023/repo', 's-iface-4f7632d7', 'public-rpc-consumer-interface', '36919aafe76c743272b323c8bca27871b5219ab9',
                 '4f7632d7f283bb38396a44d775b6a80afcd62f1b', '4f7632d7', '36919aaf preserved in 4aaba75b (frozen-1339 s-role head)'),
    't-compose': R(H / 't', 't-compose-4bb72315', 'compose-nbd', 'a9f0155c55d9284bd38b7bfc3a8015c2d01fb17d', '4bb723151e93e916f01829c2322440c0370f6919',
                   '29c6de87 cfa165fb c55917de 4bb72315', 'a9f0155c preserved in 4aaba75b (frozen-1339 t-hdd head)'),
    'ts-compose': R(H / 's', 'ts-compose-fb9ce4a7', 'compose-nbd', '92b71784c9452056eeeb6a97b8e1fcb8ef1815ca', 'fb9ce4a726e16b0652e9bdbfa851c01c6553fb07',
                    '97758444 fb9ce4a7', '92b71784 preserved in 4aaba75b (frozen-1118 s-compose head)'),
    'root-api-mcp': R(W / 'api-mcp-recovery-20261023', 'root-api-mcp-95ee73dc', 'master', None, '95ee73dcd936fc9d0243c65c2f933e2ac277b3ac', '95ee73dc', ROOTC),
}
MCP = 'metal/guest/mcp-server.bundle.mjs'
F1339 = json.loads((sp / 'frozen-1339-export/INVENTORY.json').read_text()); F1118 = json.loads((sp / 'frozen-1118-export/INVENTORY.json').read_text())
P_EXCL = tuple(F1118['derivatives']['p-compose']['excluded'])
SIA_FP = ('sia-s3/vendor/sia-sdk-rs/sia_core/src/seed.rs', 'sia-s3/vendor/sia-sdk-rs/sia_core/src/types/spendpolicy.rs', 'sia-s3/vendor/sia-sdk-rs/sia_core/src/types/v1.rs',
          'sia-s3/vendor/sia-sdk-rs/sia_core/src/types/v2.rs', 'sia-s3/vendor/sia-sdk-rs/sia_storage/src/builder.rs')
DERIVS = {
    'f-runtime-gap': R(W / 'windows-feature-gap-repair-20261023/candidate', 'f-runtime-gap-0ed6b6d9', 'gap/windows-feature-repair', '1f19ad15aaa6200e1882d148f2b43b7c25fc7058',
                       '0ed6b6d953a018a585f5fe9fadc64e0d7eca9d46', '896c5d49 2aef8ee8 548bf598 42bb4636 0de09415 dda47a35 0ed6b6d9',
                       '1f19ad15 preserved in 4aaba75b (frozen-1339 f-baseline head)', exclude=('test/service-index.test.mjs',), hold='1f19ad15aaa6200e1882d148f2b43b7c25fc7058'),
    'c-shard': R(base / 'storage-shard-recovery', 'c-shard-5c317531', 'storage/shard-recovery', None, '5c31753145445ea1f5a982d2b94c9bbee75b4fca',
                 '5c9717fc ac84cbb0 e99498e9 9eb65336 5c317531', 'root commit (C storage-shard-recovery repo; its first commit vendors the C2 candidate source)',
                 exclude=SIA_FP),
    's-iface-report': R(W / 'public-rpc-consumer-interface-20261023', 's-iface-report-a32d209e', 'master', None, 'a32d209e694c13d35682d75a6f05e32e28d72624',
                        'eb7f0db6 a32d209e', 'root commit (S consumer interface report repo)', exclude=('patch/public-rpc-consumer-interface-36919..4f7632d7.patch',)),
    't-report': R(H, 't-report-be3392d2', 'master', None, 'be3392d2c7cf47bf1663d38423221415f354a24b', 'be3392d2', 'root commit (T storage compose report repo)',
                  exclude=('receipts/run4/journal.txt',)),
    'a-receipts': R(base / 'rpc-priority/repo-receipts', 'a-receipts-eab4cfac', 'rpc-priority-receipts', '554a251cbe14aa7ba8af4c160d9a8b9793e4071a',
                    'eab4cfac47a00dcbc0161918a2624eed6761bbfb', '1d829457 cdcbdf59 23fa880a eab4cfac',
                    '554a251c preserved in 4aaba75b as the frozen-1339 a-gaps DERIVATIVE (bundle + manifest held at e32dd607)',
                    exclude=(MCP, MCP + '.manifest.json'), hold='e32dd607b55b9c6afd605482a4bc31c9d30528d6'),
    'tp-compose': R(H / 'p', 'tp-compose-ed814e58', 'compose-nbd', 'f8c999ed5a9600ef477ff05ee00b31dee366b2b1', 'ed814e5832639ecf863547536e3c8a742e39b9fb',
                    '1db4d408 ed814e58', 'f8c999ed preserved in 4aaba75b as the frozen-1118 p-compose DERIVATIVE', exclude=P_EXCL),
    'e-prod-report': R(W / 'rpc-wallet-production-build-20261023', 'e-prod-report-4beedc5b', 'master', None, '4beedc5b6811393cd400b5ace2f2018e32ba05db',
                       '3d47052b 4beedc5b', 'root commit (E production build report repo); SOURCE-ONLY DERIVATIVE (exports/ omitted)', exclude=('exports/',)),
}
FW, FG, MW, AP = '../windows-final-runtime-integration-20261023/', '../windows-feature-gap-repair-20261023/', '../privacy-startup-cancellation-20261023/', 'rpc-priority/'
FROZEN = ([FW + n for n in ('RESULT.md', 'artifacts-js-final.sha256', 'node-closure.tar.sha256', 'node-deploy-files.sha256', 'node-deploy-files.txt',
                            'b5.sh', 'build-admission.sh', 'build-js.sh', 'commit-evidence.sh', 'commit2.sh', 'compose1.sh', 'gitleaks-range.json', 'j1.sh',
                            'j1b.sh', 'j2.sh', 'j3.sh', 'j4.sh', 'jfinal.sh', 'jfix.sh', 'jrun.sh', 'q.sh', 'run-suite.py', 'scan.sh', 'setup.sh', 'snap.sh',
                            'verify-closure.sh')]
          + [FG + n for n in ('RESULT.md', 'feature-gap-repair.patch', 'commit.sh', 'd1.sh', 'd2.sh', 'd3.sh', 'gitleaks-range.json', 'q.sh', 'run-suite.py', 'scan.sh', 'setup.sh')]
          + [MW + n for n in ('RESULT.txt', 'HANDOFF.txt', 'privacy-startup-cancellation.patch', 'privacy-startup-cancellation.diff', 'commit-msg.txt',
                              'commit-msg2.txt', 'commit-msg3.txt', 'j-commit.sh', 'j-commit2.sh', 'j-commit3.sh', 'j1-daemon.sh', 'j2-coupled.sh', 'j3-all.sh',
                              'j4-diag38.sh', 'j5-recheck.sh', 'j6-bundle-diag.sh', 'j7-newfile.sh', 'q.sh')]
          + [AP + n for n in ('RESULT-RECEIPT-SOURCE.md', 'HANDOFF-RECEIPT-SOURCE.md', 'patches/enclave/0019-Verify-send-outcomes-through-the-local-L1-pair-and-B.patch',
                              'patches/enclave/0020-Fix-the-two-baseline-regressions-anvil-receipt-race-.patch',
                              'patches/enclave/0022-Keep-the-independent-mode-stray-flag-message-s-estab.patch')]
          + ['source-preservation/' + n for n in ('RESULT-frozen-1339-checkpoint.md', 'frozen-1517-a-bundle-check.sh', 'frozen-1517-a-bundle-check.out',
             'snapshots-1517/ROOT-PENDING-LATEST.snapshot-1517.txt', 'snapshots-1517/effective-goal-requirements.snapshot-1517.txt')])
ROOT_EVIDENCE = ([FW + 'ROOT-' + n + '.txt' for n in ('ACTUAL-CANCELLATION-CONFIRMED', 'CANCELLATION-FIX-OWNER', 'J1-INTEGRATION-FAILURES', 'J2-PACKAGE-COVERAGE',
                                                      'J3-STARTUP-REVIEW', 'SHARED-SHUTDOWN-OWNER')]
                 + [FG + 'ROOT-A-RECEIPT-FINAL-ROLE-OWNER.txt', FG + 'ROOT-D3-LAUNCH-REVIEW.txt']
                 + [MW + 'ROOT-' + n + '.txt' for n in ('ACTUAL-CANCELLATION-CONFIRMED', 'CLEANUP-ERROR-REVIEW', 'J3-ACTUAL-RESULTS', 'SMALL-LANE-REVIEW')]
                 + [AP + 'ROOT-RECEIPT-JOURNAL-ASSERTION.txt', 'storage-shard-recovery/ROOT-FENCE-NEGATIVE-REVIEW.txt', 'storage-shard-recovery/ROOT-OVERWRITE-STALL-REVIEW.txt',
                    '../rpc-wallet-production-build-20261023/ROOT-F-ACCOUNT-STARTUP-OWNER.txt']
                 + ['source-preservation/' + n for n in ('ROOT-A-RECEIPT-FINAL-NEXT.txt', 'ROOT-E-PRODUCTION-BUILD-FINAL-NEXT.txt', 'ROOT-F-1350-NEXT-BATCH.txt',
                    'ROOT-REBUILD-STATUS-REVIEW.txt', 'ROOT-SMALL-LANE-OBSERVED-BUDGET.txt')]
                 + ['../../outputs/decentralization-audit/' + n for n in ('windows-integration-j1-review-20261023.json', 'api-mcp-recovered-20261023.json')])


import atexit
_ATTR = tempfile.NamedTemporaryFile('w', suffix='.attributes', delete=False); _ATTR.write('* diff=nofunc1517\n'); _ATTR.close(); atexit.register(os.unlink, _ATTR.name)
NOFUNC = ('-c', f'core.attributesFile={_ATTR.name}', '-c', 'diff.nofunc1517.xfuncname=^$')


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
assert sides['e-prod']['headTree'] == '5159185616aa0600be92cb9d3308645ad59b4cf3' and sides['s-iface']['headTree'] == 'b246ba51c100ed57bc1bae9481627d492feda970', 'head trees (root)'
assert derivs['f-runtime-gap']['originalHeadTree'] == 'dfb63eafaa76a5ea1ae808ae3d5b90c04471d6a2', 'F gap repair head tree (root)'
f = derivs['f-runtime-gap']; byc = {r['commit']: r for r in f['commits']}
assert byc['0de09415815a9ca6382fc58af81b88cff193522c']['originalTree'] == '5cbdb670f5b5e60cff2f91121c2bd3e127377c96', 'F runtime source tree (root)'
fr = W / 'windows-final-runtime-integration-20261023/candidate'
assert git(fr, 'rev-parse', 'HEAD').strip() == 'dda47a35008e989cc6e62c1a79f0fefde49b29f5' and 'dda47a35008e989cc6e62c1a79f0fefde49b29f5' in byc
f['runtimeRepo'] = {'repo': str(fr.relative_to(root)), 'head': 'dda47a35008e989cc6e62c1a79f0fefde49b29f5', 'source': '0de09415815a9ca6382fc58af81b88cff193522c'}
f['heartbeatNote'] = ('root: the Linux heartbeat call cited in the F runtime report is OWNER_NOMINATION_SELFTEST only, not proof of routine on-chain '
                      'writes; 0ed6b6d9 (test-only) and its RESULT state the correction')
e = sides['e-prod']; m = next(r for r in e['commits'] if 'mergedParents' in r)
assert m['mergedParents'] == ['68b82926968c99503d38ae78dbcb04694cc2c56c'], 'E merges published main 68b82926'
e['mergeNote'] = 'e078490d merges published main 68b82926 (3 docs-only commits on 7752a423; GitHub main), exported as one diff vs its first parent'
# untracked build outputs: hashes + recipes only (not archived, not rebuilt by D)
def tree_hashes(d): return {str(q.relative_to(d)): sha(q.read_bytes()) for q in sorted(d.rglob('*')) if q.is_file()}
spk = W / 'public-rpc-consumer-interface-20261023/repo/network/host-services/packages'
sides['s-iface']['untrackedBuildOutputs'] = {'dir': str(spk.relative_to(root)), 'files': tree_hashes(spk),
    'recipe': 'node scripts/build-host-service-packages.mjs in the s-iface tree (report repo jobs/build-packages.sh)', 'note': 'local untracked files at export; NOT archived, NOT rebuilt by D'}
assert sides['s-iface']['untrackedBuildOutputs']['files']['public-rpc.package.json'] == '78f06b5b546fa2f7d6e57fb4d073e4e12f542cf0886fa1005cc80c51966d6319', 'S package pin (S report)'
ca = base / 'storage-shard-recovery/artifacts'
derivs['c-shard']['untrackedBuildOutputs'] = {'dir': str(ca.relative_to(root)), 'files': tree_hashes(ca),
    'recipe': 'the repository\'s wasm-step.sh / cargo build of sia-s3 at 9eb65336/5c317531 (RESULT-SHARD-RECOVERY.md: rebuilt from 9eb6533 to the identical 55888a41)',
    'note': 'compiled Wasm (candidate-55888a41.wasm 4,556,225 B and the pinned old 00e9cde0): NOT archived; deployed old artifact still has the bug (root)'}
assert '55888a41033c5c913f64adc7dc601d314cbe387b377445a23e5475643bea7918' in derivs['c-shard']['untrackedBuildOutputs']['files'].values(), 'C candidate wasm hash (C report)'
edm = (W / 'rpc-wallet-production-build-20261023/outputs/dist-manifest.sha256').read_bytes()
assert sha(edm).startswith('9904f5e0a44e00ed4d7e621b9a318e10256c055699683fa859799dd6df3b8ba8'[:16]), 'E dist manifest (E report / root)'
e['untrackedBuildOutputs'] = {'distManifest': 'rpc-wallet-production-build-20261023/outputs/dist-manifest.sha256 (committed in e-prod-report)', 'distManifestSha256': sha(edm),
    'note': 'the offline-built dist / build-tree (238 files per root) and its compiled tar are NOT archived; recipe = E RESULT-PRODUCTION-BUILD.md (exact commands). '
            'Root: two generated build-tree files are dirty from known stale inputs; E\'s source is not yet accepted as final production'}
ftar = (W / 'windows-final-runtime-integration-20261023/node-closure.tar').read_bytes()
f['nodeClosureTar'] = {'sha256': sha(ftar), 'bytes': len(ftar), 'note': 'binary tar NOT archived; its .sha256, the node-deploy-files lists and F\'s verify-closure.sh are captured; D did not run that script (no rebuild claim)'}
assert (W / 'windows-final-runtime-integration-20261023/node-closure.tar.sha256').read_text().split()[0] == sha(ftar), 'F node-closure.tar hash file'
f['label'] = ('SOURCE-ONLY DERIVATIVE (one file): test/service-index.test.mjs held at its 1f19ad15 bytes - its new line 90 test argument trips the '
              'unchanged gitleaks generic-api-key rule; blob/sha256 in omittedAtHead, restore from F\'s repository. Every other file exact')
c = derivs['c-shard']
c['omittedRecipe'] = {'files': SIA_FP, 'upstream': 'sia-sdk-rs commit e1d1ebe097835b728108dd809b7bc2e4cbcf801c (sia-s3/vendor/sia-sdk-rs/UPSTREAM, exported); these 3 files are not among the local test-only changes it lists',
    'why': 'upstream test vectors (public ed25519 keys, signatures) and upstream BIP39 TEST mnemonics trip the unchanged gitleaks rules and the scan-crypto-keys pre-commit hook (seed.rs, types/v1.rs added after frozen-1517-capture-1 was refused)',
    'restore': 'copy each path from upstream e1d1ebe0 (vendor root = sia-s3/vendor/sia-sdk-rs/); the git blob must equal omittedAtHead',
    'verified': 'NOT verified against upstream by D (offline); blob ids recorded from C\'s commit'}
c['label'] = 'SOURCE-ONLY DERIVATIVE: 5 vendored upstream sia-sdk-rs files omitted (scanner false positives on upstream test vectors); restore from upstream e1d1ebe0 (not verified offline)'
derivs['s-iface-report']['label'] = 'SOURCE-ONLY DERIVATIVE: S\'s own copy of its patch (patch/...36919..4f7632d7.patch) omitted - it duplicates s-iface and its hunk context truncates the public dev key, which gitleaks flags'
derivs['t-report']['label'] = 'SOURCE-ONLY DERIVATIVE: receipts/run4/journal.txt (guest kernel boot journal) omitted - a kernel build-key fingerprint line trips generic-api-key; kept in T\'s repository'
# a-receipts: the same omitted pair as frozen-1339 a-gaps, held at e32dd607 (= a-gaps' derived base state)
a = derivs['a-receipts']
assert a['originalHeadTree'] == 'e0e07f21e086c79089d0f953b1f7f031be2b54f2', 'A receipts head tree (root)'
mb = next(x for x in a['omittedAtHead'] if x['path'] == MCP); rawman = git(DERIVS['a-receipts']['repo'], 'show', f"{a['head']}:{MCP}.manifest.json"); man = json.loads(rawman)
assert len(a['omittedAtHead']) == 2 and mb['sha256'] == man['sha256'] and int(mb['bytes']) == man['bytes']
conv = out / a['patches'][0]['file'].split('/')[0] / 'converted'; conv.mkdir(parents=True, exist_ok=True)
sums = ''.join(f'{v}  {k}\n' for k, v in man['inputs'].items()); meta = {k: v for k, v in man.items() if k != 'inputs'}
(conv / 'mcp-server.bundle.mjs.manifest.inputs.sha256sums').write_text(sums); (conv / 'mcp-server.bundle.mjs.manifest.meta.json').write_text(json.dumps(meta, indent=2) + '\n')
keys = list(man.keys())
rebuilt = json.dumps({kk: (dict(reversed(l.split('  ', 1)) for l in sums.splitlines()) if kk == 'inputs' else meta[kk]) for kk in keys}, indent=2) + '\n'
assert rebuilt == rawman, 'converted manifest does not rebuild the committed bytes'
a['convertedManifest'] = {'path': MCP + '.manifest.json', 'files': [{'file': str((conv / n).relative_to(out)), 'sha256': sha((conv / n).read_bytes())}
    for n in ('mcp-server.bundle.mjs.manifest.inputs.sha256sums', 'mcp-server.bundle.mjs.manifest.meta.json')],
    'rebuild': f"json.dumps({{k: meta[k] for k in {keys}}} with inputs = dict((p, h) for each line 'h  p' in order), indent=2) + '\\n' (Python) == the committed manifest (asserted)"}
chk = (sp / 'frozen-1517-a-bundle-check.out').read_text()
validated = 'build-mcp-guest-bundle --check rc=0' in chk and f'committed bundle sha256 {mb["sha256"]}' in chk
a['omittedRecipe'] = {'path': MCP, 'gitBlob': mb['blob'], 'sha256': mb['sha256'], 'bytes': int(mb['bytes']),
    'why': 'a COMPILED esbuild bundle (not authored source), above the capture\'s 5 MB per-file bound; its manifest is omitted too (gitleaks false positive)',
    'restore': 'restore the manifest from convertedManifest, then node scripts/build-mcp-guest-bundle.mjs in the a-receipts tree with A-receipts\' own node_modules LINKS (the build uses preserveSymlinks; the roots are the manifest input prefixes)',
    'validation': ('VALIDATED: frozen-1517-a-bundle-check (clone of eab4cfac carrying A-receipts\' own node_modules links) --check rc 0' if validated
                   else 'NOT VALIDATED: frozen-1517-a-bundle-check did not return rc 0 for this bundle (see its log); the recipe is recorded, not proven')}
a['label'] = ('SOURCE-ONLY DERIVATIVE continuing frozen-1339 a-gaps: the compiled MCP bundle and its manifest held at e32dd607 bytes; manifest '
              'published converted (exact rebuild asserted); bundle rebuild ' + ('validated (--check rc 0)' if validated else 'NOT validated'))
p = derivs['tp-compose']
assert {(x['path'], x['blob']) for x in p['omittedAtHead']} == {(x['path'], x['blob']) for x in F1118['derivatives']['p-compose']['omittedAtHead']}, 'P omitted files changed'
p['omittedRecipe'] = 'unchanged since frozen-0931 p-l1 (identical blobs): its omittedRecipe and omittedFingerprintFiles apply'
derivs['e-prod-report']['label'] = 'SOURCE-ONLY DERIVATIVE: E report repo minus exports/ (git bundle - binary - and patches duplicating e-prod; recorded in omittedAtHead)'
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
inventory = {'format': 'enclave-frozen-1517-export/v1', 'checkpointHeadAtExport': CHECKPOINT_HEAD,
    'batch': '1517 = the batch start 2026-10-23T15:17Z (date -u): an identifier, not a publication time',
    'label': ('SOURCE + OFFLINE TESTS ONLY; candidates, not production completion. Nothing here is merged into the normal tree, imaged, deployed or '
              'activated by this capture. Root-designated terminal heads since 4aaba75b: A receipts eab4cfac; E production build ae00cd96 + report '
              '4beedc5b (dist not archived; 2 stale generated files unresolved); F runtime 0de09415 + evidence dda47a35 and gap repair 0ed6b6d9 '
              '(heartbeat allegation corrected); M startup cancellation 3746e4fc; S consumer interface 4f7632d7 + report a32d209e (TLS/history '
              'gaps remain); C shard recovery 5c317531 (fixture 18/18 known hosts filtered, not WAN; deployed old artifact still has the bug); T storage '
              'compose t 4bb72315 / s fb9ce4a7 / p ed814e58 + report be3392d2 (local systemd guest/host tests; no physical deployment); ROOT api-mcp '
              'recovery 95ee73dc (root ran it on NucBox; no source deployment).'),
    'sides': sides, 'derivatives': derivs, 'lowercaseRewrittenLiteral': lit, 'frozenSources': frozen, 'rootEvidence': evidence,
    'evidenceVsSource': 'Committed logs, receipts, run outputs and RESULT files inside these repositories are EVIDENCE; the rest is source.',
    'notPreserved': ['A metal/guest/mcp-server.bundle.mjs + manifest at eab4cfac (compiled; manifest published converted) and A patch 0021 (its rebuild diff)',
                     'E report exports/ (git bundle + duplicate patches); E dist/build-tree and compiled tar (manifest hash recorded)',
                     'F node-closure.tar (binary; hash recorded, .sha256 and deploy lists captured); C artifacts/*.wasm (hashes recorded)',
                     'S untracked network/host-services/packages/ (hashes + recipe recorded)',
                     'untracked/ignored files in every repo; api-mcp-recovery untracked claude-progress/claude-task and its ROOT live notes (active incident review)',
                     'ACTIVE successor trees: A credit-vault-submitter-verifier, E site-generated-artifacts-reconcile, new F/S/T work, B and P']}
(out / 'INVENTORY.json').write_text(json.dumps(inventory, indent=1) + '\n')
print(json.dumps({k: {'commits': len(v['commits']), 'files': len(v['changedFiles'])} for k, v in {**sides, **derivs}.items()}
                 | {'bundleRecipeValidated': validated, 'frozen': len(frozen), 'rootEvidence': len(evidence), 'literalFiles': len(lit), 'inventorySha256': sha((out / 'INVENTORY.json').read_bytes())}))

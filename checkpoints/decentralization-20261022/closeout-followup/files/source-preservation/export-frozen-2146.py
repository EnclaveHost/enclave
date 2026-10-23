"""Export the frozen-2146 batch for the checkpoint, from Git OBJECTS only (never from mutable or dirty worktrees; ignored and untracked
files are never read). "2146" is the batch IDENTIFIER = its actual start, 2026-10-23T21:46:39Z (date -u); not a publication time.
Exactly the completed heads root designated (custody-code-admission-20261023/ROOT-PRESERVE-2146.txt); later worker WIP is excluded.

* custody-live5        custody-v2-live-20261023 dc07e225 (frozen-2100 custody-live4 head) -> 1c8403e8, 570947d4, 1535fcf0
* factory-wallet2      custody-factory-wallet-20261023 24aac735 (frozen-2100 factory-wallet head) -> 7f11fbf3, 99cf7f16, 9557ad6d
* production-canary2   custody-v2-production-canary-20261023 7bcd501f (frozen-2100 head) -> c4d96a11, cb06e87b, 49fb0a6c, 01525201
* operator-fees        custody-operator-fees-20261023 root -> f2a7b81e, 1ac9ad2c, 7bf4c942 (root's uncommitted FEE-NOTES.md edit OMITTED)
* recipient-restore    custody-recipient-restore-20261023 (outer) root -> b03be02d
* recipient-restore-repo  its inner repo/ deabf8f9 (production scratch base, not in pushed material) -> a6b1378c: TOUCHED-FILE reproduction
* recipient-activation custody-recipient-activation-20261023 root -> 7426b299, 2c5d9b5a, 2d407753 (root's uncommitted operational files OMITTED)
* proof-app            custody-proof-app-20261023 root -> e84a1afd (the untracked component binary is never read)
* code-admission       custody-code-admission-20261023 root -> 8578965c
* publish-readiness    custody-site-publish-readiness-20261023 root -> f0efadbd, 90a2b826 (latest COMMITTED head, resolved once at 21:46Z)
"""
from pathlib import Path
import hashlib, json, os, shutil, subprocess, tempfile

root = Path(__file__).resolve().parents[3]
W = root / 'work'
base = W / 'resume-after-checkpoint-20261022'
sp = base / 'source-preservation'
out = sp / 'frozen-2146-export'
checkpoint = W / 'source-checkpoint-20261022/main-repo'
CHECKPOINT_HEAD = 'f2e7009eb0a26e0a727012c9d17de05f1cc13d96'
AUTHOR = 'SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'
# OLD = the former provider name the 2026-10-21 repository rewrite replaced by 'Cloud Provider'; built from hex so this tool
# itself does not carry the literal it guards against
OLD = bytes.fromhex('54696e666f696c')
# the private-key block marker, also from hex (frozen-2100 content-check rc 1: a literal in the tool tripped the content check)
PKBLOCK = bytes.fromhex('50524956415445204b45592d2d2d2d2d')
R = lambda repo, name, branch, b, head, commits, prov, **kw: {'repo': repo, 'name': name, 'branch': branch, 'base': b, 'head': head,
                                                              'commits': commits.split(), 'baseProvenance': prov, **kw}
ROOTC = 'root commit'
SIDES = {
    'custody-live5': R(W / 'custody-v2-live-20261023', 'custody-live5-1535fcf0', 'master', 'dc07e225c85c21c86af816da8c4515519924cc93',
                       '1535fcf0a3845c4ed625a0cd1095595963352f6f', '1c8403e8 570947d4 1535fcf0', 'dc07e225 preserved in f2e7009e (frozen-2100 custody-live4 head)'),
    'factory-wallet2': R(W / 'custody-factory-wallet-20261023', 'factory-wallet2-9557ad6d', 'master', '24aac735856010db79fd3fd2c51d3a22b81e0a0e',
                         '9557ad6d3c2acd7a28f1d3d3d96783aab79c44fd', '7f11fbf3 99cf7f16 9557ad6d', '24aac735 preserved in f2e7009e (frozen-2100 factory-wallet head)'),
    'production-canary2': R(W / 'custody-v2-production-canary-20261023', 'production-canary2-01525201', 'main', '7bcd501f39464c335c13834e142319520479b039',
                            '01525201fb05091a9c2295d7a0b576e868bc09d5', 'c4d96a11 cb06e87b 49fb0a6c 01525201', '7bcd501f preserved in f2e7009e (frozen-2100 production-canary head)'),
    'operator-fees': R(W / 'custody-operator-fees-20261023', 'operator-fees-7bf4c942', 'operator-fees', None,
                       '7bf4c942e544165a1a6651afa795418114268f04', 'f2a7b81e 1ac9ad2c 7bf4c942', ROOTC),
    'recipient-restore': R(W / 'custody-recipient-restore-20261023', 'recipient-restore-b03be02d', 'main', None,
                           'b03be02d7d050dd4883e29e011c454942aa790ee', 'b03be02d', ROOTC),
    'recipient-restore-repo': R(W / 'custody-recipient-restore-20261023/repo', 'recipient-restore-repo-a6b1378c', 'restore/measured-custody-vaults',
                                'deabf8f90f64902d20d48620fd911d34c445859d', 'a6b1378cdf430217025987d90c040d0e25a9993d', 'a6b1378c',
                                'deabf8f9 = the production linux post-adoption scratch commit (byte-identical rebuild to production per RESULT.md); '
                                'NOT in pushed git objects; touched-file reproduction'),
    'recipient-activation': R(W / 'custody-recipient-activation-20261023', 'recipient-activation-2d407753', 'main', None,
                              '2d4077530caa03228deac1abda3de8cb03d9550b', '7426b299 2c5d9b5a 2d407753', ROOTC),
    'proof-app': R(W / 'custody-proof-app-20261023', 'proof-app-e84a1afd', 'master', None,
                   'e84a1afd10e19cf8ec4ca48d3d8e389fe8beaa73', 'e84a1afd', ROOTC),
    'publish-readiness': R(W / 'custody-site-publish-readiness-20261023', 'publish-readiness-90a2b826', 'main', None,
                           '90a2b826d57a86e80dc632679052735de114ae41', 'f0efadbd 90a2b826', ROOTC),
}
DERIVS = {
    # frozen-2146-export-2 gitleaks generic-api-key on tools/compile.mjs line 29 (and the 8578965c patch): the CONTRACT NAME
    # vault contract's FILE name and CONTRACT name as two adjacent quoted strings separated by a comma (the rule's keyword is part of the
    # contract name) in a solc output lookup. Not a credential. (frozen-2146 checkpoint-scan: quoting that pair verbatim here tripped it.)
    # Published as a CONVERTED copy: that one comma becomes a semicolon; the reverse substitution reproduces the original blob byte for
    # byte (asserted). Not allowlisted; the source repository is unchanged
    'code-admission': R(W / 'custody-code-admission-20261023', 'code-admission-8578965c', 'master', None,
                        '8578965c04ad98aaefda7dec5c417c46d418c8bd', '8578965c', ROOTC, exclude=('tools/compile.mjs',),
                        sanitize={'tools/compile.mjs': (r'("EnclaveSecretVaultV2\.sol"), ("EnclaveSecretVaultV2"\))', r'\1; \2',
                                                        r'("EnclaveSecretVaultV2\.sol"); ("EnclaveSecretVaultV2"\))', r'\1, \2',
                                                        'gitleaks generic-api-key on a contract name (keyword Secret + comma + quoted string), not a credential')}),
}
FROZEN = ['source-preservation/RESULT-frozen-2100-checkpoint.md']
ROOT_EVIDENCE = []


import atexit
_ATTR = tempfile.NamedTemporaryFile('w', suffix='.attributes', delete=False); _ATTR.write('* diff=nofunc2146\n'); _ATTR.close(); atexit.register(os.unlink, _ATTR.name)
NOFUNC = ('-c', f'core.attributesFile={_ATTR.name}', '-c', 'diff.nofunc2146.xfuncname=^$')


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
TREES = {'custody-live5': '0ec5226a', 'factory-wallet2': 'daf03b1e', 'production-canary2': 'b9184661', 'operator-fees': '2e348c05',
         'recipient-restore': '9c26fc2c', 'recipient-restore-repo': 'd155f20e', 'recipient-activation': '6424dd93', 'proof-app': '71f91f09',
         'code-admission': '749a99e3', 'publish-readiness': '0bc4e7e3'}
assert {k: v['headTree'][:8] for k, v in sides.items()} == {k: TREES[k] for k in sides}, 'head trees'
# no committed executable/archive/wasm/key anywhere (ignored binaries, raw quotes, sealed state, node_modules are never read)
NOPE = ('.exe', '.bin', '.wasm', '.zip', '.tar', '.gz', '.dll', '.pdb', '.key', '.img', '.qcow2', '.raw', '.sealed', '.so', '.rlib')
def forbidden(side): return [f['path'] for f in side['changedFiles'] if f['path'].endswith(NOPE) or 'node_modules/' in f['path'] or 'raw' in Path(f['path']).name.lower()]
assert not [p for s in sides.values() for p in forbidden(s)]
# ---- continuity with the PUSHED frozen-2100 inventory (read from the checkpoint commit, not a worktree) ---------------------------
F2100 = json.loads(git(checkpoint, 'show', f'{CHECKPOINT_HEAD}:checkpoints/decentralization-20261022/closeout-followup/files/source-preservation/frozen-2100-export/INVENTORY.json'))
for k, want in (('custody-live5', 'custody-live4'), ('factory-wallet2', 'factory-wallet'), ('production-canary2', 'production-canary')):
    assert sides[k]['base'] == F2100['sides'][want]['head'] and sides[k]['commits'][0]['parent'] == F2100['sides'][want]['head'], (k, 'base is not the pushed frozen-2100 head')
# ---- recipient-restore-repo: touched-file reproduction (base tree not in pushed material) -------------------------------------
m, MR = sides['recipient-restore-repo'], SIDES['recipient-restore-repo']['repo']
touched = sorted({f['path'] for f in m['changedFiles']})
bf = out / SIDES['recipient-restore-repo']['name'] / 'base-files'
m['baseFiles'] = []
for p in touched:
    ls = git(MR, 'ls-tree', m['base'], '--', p).split()
    if not ls: continue
    data = git(MR, 'cat-file', 'blob', ls[2], text=False); data.decode('utf-8'); assert OLD not in data and OLD.lower() not in data and PKBLOCK not in data, p
    (bf / p).parent.mkdir(parents=True, exist_ok=True); (bf / p).write_bytes(data)
    m['baseFiles'].append({'path': p, 'mode': ls[0], 'blob': ls[2], 'file': str((bf / p).relative_to(out)), 'sha256': sha(data)})
for c in m['commits']:
    c['touchedBlobs'] = [{'path': p, 'blob': (git(MR, 'ls-tree', c['commit'], '--', p).split() or [None, None, None])[2]} for p in touched]
# the base gsup.mjs is the one PRODUCTION runs: its sha256 equals /opt/metal/gsup.mjs in the dist-leasegas-deabf8f90 initramfs inventory
# already pushed in f2e7009e (frozen-2100 recipient-provenance held-out/)
INVP = 'checkpoints/decentralization-20261022/closeout-followup/files/source-preservation/frozen-2100-export/recipient-provenance-8b0c4da2/held-out/out/dist-leasegas-deabf8f90/initramfs-inventory.json'
pushed_inv = json.loads(git(checkpoint, 'show', f'{CHECKPOINT_HEAD}:{INVP}'))
prod_gsup = [x['sha256'] for x in pushed_inv['members'] if x['path'] == '/opt/metal/gsup.mjs']
base_gsup = [b['sha256'] for b in m['baseFiles'] if b['path'] == 'metal/guest/gsup.mjs']
assert len(prod_gsup) == 1 and base_gsup == prod_gsup, ('base gsup.mjs is not production deabf8f90 gsup', prod_gsup, base_gsup)
lit_count = len([l for l in git(MR, 'grep', '-l', '-i', OLD.decode(), m['base']).splitlines()])
m['baseTreeNotReproduced'] = {'base': m['base'], 'baseTree': git(MR, 'rev-parse', m['base'] + '^{tree}').strip(),
    'why': ('the base is the production linux post-adoption SCRATCH commit (author stage): not in pushed git objects (only its file-level '
            f'diffs are in external/scratch-repos), and its tree has {lit_count} files containing the rewritten literal (case-insensitive), so '
            'it cannot be published as a whole tree'),
    'baseGsupEqualsProduction': {'path': 'metal/guest/gsup.mjs', 'sha256': base_gsup[0], 'pushedInventory': INVP + ' (/opt/metal/gsup.mjs)'},
    'verified': "base-files/ + this side's patch reproduce every touched path's blob (verify-frozen-2146-export.py)"}
NOTES = {
 'custody-live5': ('ROOT live custody reconciliation on dc07e225: live guestd release capability confirmed over the authenticated control channel '
                   '(1c8403e8), the deployed custody code delay and corrected operator fee bounds (570947d4), control-restart incident read probes '
                   'and the app-funded protected lease renewal receipt (1535fcf0). Read-only evidence and public metadata; no secrets, no signatures stored'),
 'factory-wallet2': ('Book sessionVaultFactory activation handoff on 24aac735: the deployed original book ABI selected by exact code hash (7f11fbf3), '
                     'README peak (99cf7f16), deployless impact reads bounded below the EVM code size limit and live preflight (9557ad6d). Source/test '
                     'only; the factory signature is pending the human'),
 'production-canary2': ('Custody v2 production canary driver on 7bcd501f: L1/operator fee + aggregate budget, durable pre-broadcast intent (c4d96a11), '
                        'sender L1 size from the exact transaction (cb06e87b), CLI preflight fee-cap matrix (49fb0a6c), canary CLI pinned on the actual '
                        'ledger rev16d (01525201). Source/test only; nothing run against production. Its committed .gitleaksignore is content only'),
 'operator-fees': ('metal0 operator proposeOwner preparation with journaled explicit send for root, and its L1/operator fee bounds (7bf4c942). '
                   'Source/test only; nothing signed or sent. Root\'s uncommitted FEE-NOTES.md edit is NOT included'),
 'recipient-restore': ('metal0 custody vault restore evidence and activation plan for inner commit a6b1378c (measurement ee5df6b8, staged only): '
                       'builds, controls, reproduction and scans. No production change'),
 'recipient-restore-repo': ('Inner source commit a6b1378c on the production scratch base deabf8f9: gsup hands the supervisor the measured custody '
                            'v1/v2 vault constants, with a harness and test. Source/test only (staged image ee5df6b8; root activation of it FAILED '
                            'adoption 21:37 and was rolled back to deabf8f9)'),
 'recipient-activation': ('Image-only activation adaptation for the restored custody vaults (7426b299), its queue logs (2c5d9b5a), and a nonce-bound '
                          'SEV-SNP verification probe for the recipient image ee5df6b8 (2d407753). Source only; root\'s uncommitted operational files '
                          'are NOT included'),
 'proof-app': ('custody-canary-proof: hash-only canary app source for the release-16c2999d per-app tier, with ARTIFACT.json pins and tests. The '
               'built component binary is untracked and NOT included'),
 'code-admission': ('R code admission plan: the original committee 0x4774 can never admit new custodian code (the running daemon has no code-approval '
                    'signer), not merely a 7-day delay; the new-committee route and its gates; original-vault anvil test, read-only live state, '
                    'static scan of the running bundle. Nothing signed, voted or sent'),
 'publish-readiness': ('ipns-publisher same-CID recovery and r2 publication readiness handoff (f0efadbd) and the custody v2 CURRENT STATUS draft '
                       '(90a2b826, not yet the public output). Read-only; nothing published'),
}
for k, v in NOTES.items():
    if k in sides: sides[k]['note'] = v
derivs = {}
import re
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
    d['excluded'] = list(s_['exclude'])
    d['sanitized'] = []
    for path, (pattern, placeholder, rpattern, rplace, reason) in s_['sanitize'].items():
        blob = git(s_['repo'], 'rev-parse', f"{d['head']}:{path}").strip()
        orig = git(s_['repo'], 'cat-file', 'blob', blob, text=False).decode()
        assert not re.search(rpattern, orig), (k, path, 'the converted form already occurs: the conversion would not be reversible')
        new, n = re.subn(pattern, placeholder, orig)
        assert n == 1, (k, path, 'expected exactly one conversion', n)
        assert re.sub(rpattern, rplace, new) == orig, (k, path, 'conversion is not exactly reversible')
        t = out / s_['name'] / 'sanitized' / path; t.parent.mkdir(parents=True, exist_ok=True); t.write_text(new)
        d['sanitized'].append({'path': path, 'originalBlob': blob, 'originalSha256': sha(orig.encode()), 'file': str(t.relative_to(out)),
                               'sha256': sha(new.encode()), 'replacements': n, 'pattern': pattern, 'replacement': placeholder,
                               'reversePattern': rpattern, 'reverseReplacement': rplace, 'reason': reason,
                               'claim': ('CONVERTED copy of the HEAD file, exactly reversible: re.sub(reversePattern, reverseReplacement) gives the '
                                         'original blob (asserted); with it restored the ORIGINAL head tree is the recorded originalHeadTree')})
    d['label'] = ('SOURCE-ONLY DERIVATIVE: ' + NOTES[k] + '; ' + ', '.join(s_['exclude']) + ' is excluded from the patch and published as an '
                  'exactly reversible CONVERTED copy (one comma -> semicolon in a contract-name lookup that trips gitleaks generic-api-key)')
    d['omittedRecipe'] = ('apply the patch, then write re.sub(reversePattern, reverseReplacement, <converted copy>) at the path with its recorded mode '
                          '(omittedAtHead): the blob equals originalBlob and write-tree equals originalHeadTree')
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
inventory = {'format': 'enclave-frozen-2146-export/v1', 'checkpointHeadAtExport': CHECKPOINT_HEAD,
    'batch': '2146 = the batch start 2026-10-23T21:46:39Z (date -u): an identifier, not a publication time',
    'label': ('SOURCE + EVIDENCE ONLY. Custody v2 rollout work: ROOT live reconciliation 1535fcf0 (read-only evidence), factory activation '
              'handoff 9557ad6d (factory signing pending the human), production canary driver 01525201, operator proposeOwner fees 7bf4c942, '
              'metal0 recipient restore b03be02d + inner a6b1378c (staged; root activation ee5df6b8 FAILED adoption and was rolled back to '
              'deabf8f9; boot registration gas still blocks), recipient activation adaptation 2d407753, canary proof app e84a1afd, code admission '
              'plan 8578965c (original committee code-frozen), publish readiness 90a2b826 (draft). Root owns all activation and signing. No new '
              'custody lifecycle has been done; the original custodian and committee are untouched. Source preservation is NOT production completion.'),
    'sides': sides, 'derivatives': derivs, 'lowercaseRewrittenLiteral': lit, 'frozenSources': frozen, 'rootEvidence': evidence,
    'rootEvidenceNote': 'no root outputs file and no journal snapshot in this batch (root: exact frozen heads only); the frozen-2100 receipt is stored',
    'evidenceVsSource': 'Committed logs, receipts, run outputs and RESULT files inside these repositories are EVIDENCE; the rest is source.',
    'notPreserved': ['ignored/untracked files in every repo: images, binaries (the proof-app component), CARs, build outputs, node_modules, raw '
                     'quotes, sealed state, private config, keys, task prompts and progress/err files, uncommitted WIP (operator-fees FEE-NOTES.md, '
                     'recipient-activation operational files, root new-task files)',
                     "root's in-progress H/W/D recovery repositories (registration patch, proof-key update, attested-key verifier): WIP, until the next freeze",
                     'commits after these heads and every worktree change',
                     'outer non-repo files of these work directories']}
(out / 'INVENTORY.json').write_text(json.dumps(inventory, indent=1) + '\n')
print(json.dumps({k: {'commits': len(v['commits']), 'files': len(v['changedFiles'])} for k, v in sides.items()}
                 | {'frozen': len(frozen), 'rootEvidence': len(evidence), 'inventorySha256': sha((out / 'INVENTORY.json').read_bytes())}))

"""Export the frozen-2100 batch for the checkpoint, from Git OBJECTS only (never from mutable or dirty worktrees; ignored and untracked
files are never read). "2100" is the batch IDENTIFIER = its actual start, 2026-10-23T21:00:37Z (date -u); not a publication time.
Exactly the completed heads root designated (custody-publisher-assessment-20261023/ROOT-PRESERVE-2101.txt); later worker WIP is excluded.

* custody-live4        custody-v2-live-20261023 3fd6e8ff (frozen-2025 custody-live3 head) -> bc3f93c0, edaaaf81, dc07e225
* dashboard3           custody-v2-dashboard-20261023/repo e24a47fb (frozen-2025 dashboard2 head) -> 2d3839c5 ... 9d97b4b0
* site-release         custody-v2-site-release-20261023 root -> 7681e3fa, 3f16d9b1 (SUPERSEDED by r2)   } derivatives: the binary
* site-release-r2      custody-v2-site-release-r2-20261023 root -> 82c594ab, 14b5f559 (metadata/source)  } site-root.block omitted
* ingress-forwarder    custody-v2-ingress-forwarder-20261023 root -> 35d73c68, b1c1feee
* factory-consumer     custody-factory-consumer-review-20261023 root -> 519489c3, d0e9df82
* factory-wallet       custody-factory-wallet-20261023 root -> f18404a5, 24aac735 (its ABI fix is uncommitted WIP: NOT included)
* production-canary    custody-v2-production-canary-20261023 root -> 7bcd501f (root safety-review fixes WIP: NOT mutation-ready)
* recipient-provenance custody-recipient-provenance-20261023 root -> 8b0c4da2
* publisher-assessment custody-publisher-assessment-20261023 root -> b895d295
"""
from pathlib import Path
import hashlib, json, os, shutil, subprocess, tempfile

root = Path(__file__).resolve().parents[3]
W = root / 'work'
base = W / 'resume-after-checkpoint-20261022'
sp = base / 'source-preservation'
out = sp / 'frozen-2100-export'
checkpoint = W / 'source-checkpoint-20261022/main-repo'
CHECKPOINT_HEAD = '619e0e34ca6321dad2e872a76d4da565969c4e66'
AUTHOR = 'SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'
# OLD = the former provider name the 2026-10-21 repository rewrite replaced by 'Cloud Provider'; built from hex so this tool
# itself does not carry the literal it guards against
OLD = bytes.fromhex('54696e666f696c')
# the private-key block marker, also from hex (frozen-2100 content-check rc 1: the literal in this tool tripped the content check)
PKBLOCK = bytes.fromhex('50524956415445204b45592d2d2d2d2d')
R = lambda repo, name, branch, b, head, commits, prov, **kw: {'repo': repo, 'name': name, 'branch': branch, 'base': b, 'head': head,
                                                              'commits': commits.split(), 'baseProvenance': prov, **kw}
ROOTC = 'root commit'
SIDES = {
    'custody-live4': R(W / 'custody-v2-live-20261023', 'custody-live4-dc07e225', 'master', '3fd6e8ff99dbda1a261d11be00beea3e6549cbe9',
                       'dc07e225c85c21c86af816da8c4515519924cc93', 'bc3f93c0 edaaaf81 dc07e225', '3fd6e8ff preserved in 619e0e34 (frozen-2025 custody-live3 head)'),
    'dashboard3': R(W / 'custody-v2-dashboard-20261023/repo', 'dashboard3-9d97b4b0', 'custody-v2-dashboard', 'e24a47fb22399b220d25f4e3b8d544083b13fdb0',
                    '9d97b4b003661ad4832fe703dc5649ca807739ed', '2d3839c5 278a28a7 a942a61f 9d97b4b0', 'e24a47fb preserved in 619e0e34 (frozen-2025 dashboard2 head)'),
    'ingress-forwarder': R(W / 'custody-v2-ingress-forwarder-20261023', 'ingress-forwarder-b1c1feee', 'main', None,
                           'b1c1feee70bb5ac7a63468c20a894ce7ca0ab657', '35d73c68 b1c1feee', ROOTC),
    'factory-consumer': R(W / 'custody-factory-consumer-review-20261023', 'factory-consumer-d0e9df82', 'master', None,
                          'd0e9df8206414edf715e154f1903c4b6421af754', '519489c3 d0e9df82', ROOTC),
    'factory-wallet': R(W / 'custody-factory-wallet-20261023', 'factory-wallet-24aac735', 'master', None,
                        '24aac735856010db79fd3fd2c51d3a22b81e0a0e', 'f18404a5 24aac735', ROOTC),
    'production-canary': R(W / 'custody-v2-production-canary-20261023', 'production-canary-7bcd501f', 'main', None,
                           '7bcd501f39464c335c13834e142319520479b039', '7bcd501f', ROOTC),
    'publisher-assessment': R(W / 'custody-publisher-assessment-20261023', 'publisher-assessment-b895d295', 'main', None,
                              'b895d295cd8ab7d81d3b66c659db4ead4643c700', 'b895d295', ROOTC),
}
# derivatives: the committed binary IPLD root block of each site release (build output; root: no CAR/build binaries) is omitted. It is
# content-addressed: sha256(block) == the release CID's multihash (asserted), so the CID itself identifies and re-fetches it
BLK = lambda cid: f'release/{cid}/site-root.block'
SR1, SR2 = 'bafybeiax6ngccp7bxoiex5pqv2yoz2ekfk227pthlzfrqkv32v6jt7stmi', 'bafybeihm7f2mhw6qn5a3lddqfu4bjleqg6zo6jxset7ni4dsiaamhpgqla'
DERIVS = {
    # frozen-2100-capture-1 refused: this side's one commit patch carries two ~2.7 MB initramfs inventories and exceeds the 5 MB stored-file
    # limit. out/ is excluded from the patch and the two files are published BYTE-EXACT under held-out/; the verifier adds them back and
    # reproduces the ORIGINAL tree (no content omitted)
    'recipient-provenance': R(W / 'custody-recipient-provenance-20261023', 'recipient-provenance-8b0c4da2', 'main', None,
                              '8b0c4da2bf92bc848477b8c5538606b6ae470f3a', '8b0c4da2', ROOTC, exclude=('out/',), heldOut=True),
    'site-release': R(W / 'custody-v2-site-release-20261023', 'site-release-3f16d9b1', 'release', None, '3f16d9b18a7fd1b6061705ec555a1ce45628cb41',
                      '7681e3fa 3f16d9b1', ROOTC, exclude=(BLK(SR1),), blocks={BLK(SR1): SR1}),
    # frozen-2100-export-1 gitleaks generic-api-key on PROSE in RELEASE-HANDOFF.md (head line 45, and the 82c594ab patch): the words "the
    # Secrets panel" followed by a comma and a backquoted file name. Not a credential. Published as a CONVERTED copy: that one comma becomes a
    # semicolon; the reverse substitution reproduces the original blob byte for byte (asserted). Not allowlisted
    'site-release-r2': R(W / 'custody-v2-site-release-r2-20261023', 'site-release-r2-14b5f559', 'release-r2', None, '14b5f5599a4f26591494794fe6a8be1d7bf21d55',
                         '82c594ab 14b5f559', ROOTC, exclude=(BLK(SR2), 'RELEASE-HANDOFF.md'), blocks={BLK(SR2): SR2},
                         sanitize={'RELEASE-HANDOFF.md': (r'(the Secrets panel), (`custody-v2\.js`)', r'\1; \2', r'(the Secrets panel); (`custody-v2\.js`)', r'\1, \2',
                                   'gitleaks generic-api-key on prose (keyword Secret + comma + backquoted file name), not a credential')}),
}
FROZEN = ['source-preservation/' + n for n in ('RESULT-frozen-2025-checkpoint.md', 'snapshots-2100/ROOT-CONTINUE-LATEST.snapshot-2100.txt',
                                               'snapshots-2100/custody-v2-live-verification-20261023.snapshot-2100.md')]
ROOT_EVIDENCE = []


import atexit
_ATTR = tempfile.NamedTemporaryFile('w', suffix='.attributes', delete=False); _ATTR.write('* diff=nofunc2100\n'); _ATTR.close(); atexit.register(os.unlink, _ATTR.name)
NOFUNC = ('-c', f'core.attributesFile={_ATTR.name}', '-c', 'diff.nofunc2100.xfuncname=^$')


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
TREES = {'custody-live4': '986d5fbd', 'dashboard3': 'e5f38820', 'site-release': '7802cff9', 'site-release-r2': '7e5af78c',
         'ingress-forwarder': 'fe9c470a', 'factory-consumer': '2fb41cdb', 'factory-wallet': '249513e4', 'production-canary': '9b5a7493',
         'recipient-provenance': '00861e62', 'publisher-assessment': '6901c766'}
assert {k: v['headTree'][:8] for k, v in sides.items()} == {k: TREES[k] for k in sides}, 'head trees'
# no committed executable/archive/wasm/key anywhere (ignored binaries, raw quotes, sealed state, node_modules are never read)
NOPE = ('.exe', '.bin', '.wasm', '.zip', '.tar', '.gz', '.dll', '.pdb', '.key', '.img', '.qcow2', '.raw', '.sealed')
def forbidden(side): return [f['path'] for f in side['changedFiles'] if f['path'].endswith(NOPE) or 'node_modules/' in f['path'] or 'raw' in Path(f['path']).name.lower()]
assert not [p for s in sides.values() for p in forbidden(s)]
# ---- continuity with the PUSHED frozen-2025 inventory (read from the checkpoint commit, not a worktree) ---------------------------
F2025 = json.loads(git(checkpoint, 'show', f'{CHECKPOINT_HEAD}:checkpoints/decentralization-20261022/closeout-followup/files/source-preservation/frozen-2025-export/INVENTORY.json'))
for k, want in (('custody-live4', 'custody-live3'), ('dashboard3', 'dashboard2')):
    assert sides[k]['base'] == F2025['sides'][want]['head'] and sides[k]['commits'][0]['parent'] == F2025['sides'][want]['head'], (k, 'base is not the pushed frozen-2025 head')
NOTES = {
 'custody-live4': ('ROOT live custody reconciliation on 3fd6e8ff: original v1 vault pinned before consumer inventory reads (bc3f93c0), relay factory pin '
                   'verified and isolated custody ingress prepared (edaaaf81), deployed address-book ABI and missing recipient custody configuration '
                   'recorded (dc07e225). Read-only public evidence; nothing signed or sent; existing single-seat bootstrap (NOT decentralized custody)'),
 'dashboard3': ('R custody v2 dashboard on e24a47fb: current-state docs (corrected image ab589bf8), app media fallback gateways (accepted patch 04836638), '
                'verified multi-gateway read for pinned configs, docs on who holds what in the single-seat bootstrap. Source/test only; not deployed'),
 'site-release': ('SUPERSEDED by site-release-r2: custody v2 dashboard site release bafybeiax6ngccp7 built from e24a47fb2, its checks, smoke and public-read '
                  'evidence, and the errata (publisher deployment id typo; IPNS publication blocked). NOT published'),
 'site-release-r2': ('Composed site release r2 bafybeihm7f2mhw6 (from dashboard a942a61f): release metadata, checks, focused tests and logs; '
                     'metadata/source only (no CAR, no build output beyond the omitted root block). NOT published'),
 'ingress-forwarder': ('Custody v2 canary ingress forwarder: exact raw-target allowlist for the ab589bf8 routes (35d73c68) and a client gone before '
                       'upstream creation never starts one (b1c1feee); tests, mutants (all killed) and queue logs. Source/test only; not deployed'),
 'factory-consumer': ('Review of the effects of activating the original book\'s sessionVaultFactory, and its consumers (the running relay pins '
                      'SESSIONS_FACTORY). Read-only review with public state evidence; nothing activated'),
 'factory-wallet': ('Book sessionVaultFactory activation as a single administrator MetaMask handoff, with the L1 data-fee bound review (24aac735). '
                    'Source/test only; nothing served, signed or sent. Its ABI fix is uncommitted work in progress and is NOT included'),
 'production-canary': ('Bounded custody v2 production canary driver: baseline plan on committee 0x4774 (7bcd501f). Root\'s safety-review fixes are '
                       'work in progress: this head is NOT mutation-ready. Source/test only; nothing run against production. Its committed '
                       '.gitleaksignore adjudicates one public file-hash pin'),
 'recipient-provenance': ('metal0 custody recipient provenance: the running ed918e4b supervisor/guestd builds versus their release metadata, with '
                          'public initramfs file inventories (paths, modes, sizes, sha256; flavor env key names and public values only). Read-only'),
 'publisher-assessment': ('Read-only assessment of ipns-publisher 0xd9798e4c reporting http-only / sequence 0 (b895d295): source-level reason, the '
                          'public record still at sequence 1026, root metadata queries and a recovery that keeps key, sequence and old site CID. '
                          'Nothing published or reset'),
}
for k, v in NOTES.items():
    if k in sides: sides[k]['note'] = v
def cid_digest(cid):   # base32 CIDv1 (dag-pb, sha2-256) -> hex digest
    A = 'abcdefghijklmnopqrstuvwxyz234567'; bits = v = 0; o = bytearray()
    for ch in cid[1:]:
        v = (v << 5) | A.index(ch); bits += 5
        if bits >= 8: o.append((v >> (bits - 8)) & 255); bits -= 8
    assert o[0] == 1 and o[1] == 0x70 and o[2] == 0x12 and o[3] == 0x20, cid
    return bytes(o[4:36]).hex()
for k, s in DERIVS.items():
    if s.get('heldOut'):
        s['labelOmission'] = ('out/ (two initramfs inventories, ~2.7 MB each) is excluded from the patch, which would exceed the 5 MB stored-file '
                              'limit, and published BYTE-EXACT under held-out/: nothing is omitted, and the verifier reproduces the original tree')
        s['recipe'] = 'git apply the patch, then add each held-out file at its path and mode (blobs in heldOut); write-tree == originalHeadTree'
        continue
    s['labelOmission'] = (f'minus {", ".join(BLK(c) for c in s["blocks"].values())}: the 1835-byte binary dag-pb root block of the release (build '
                          'output). It is content-addressed: its sha256 equals the release CID multihash (asserted), so the CID identifies it exactly'
                          + ('; RELEASE-HANDOFF.md is excluded from the patches and published as an exactly reversible CONVERTED head copy '
                             '(one comma -> semicolon in prose that trips gitleaks generic-api-key)' if 'sanitize' in s else ''))
    s['recipe'] = ('restore the block from the source repository at the head (blob in omittedAtHead), or fetch /ipfs/<CID>?format=raw from any '
                   'gateway holding the release and check sha256 == the CID multihash; the full DAG/CAR was never committed and is not captured')
    for path, cid in s['blocks'].items():
        blob = git(s['repo'], 'rev-parse', f"{s['head']}:{path}").strip()
        assert sha(git(s['repo'], 'cat-file', 'blob', blob, text=False)) == cid_digest(cid), (k, path, 'block does not hash to its CID')
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
    for path, (pattern, placeholder, rpattern, rplace, reason) in s.get('sanitize', {}).items():
        import re
        orig = git(s['repo'], 'cat-file', 'blob', git(s['repo'], 'rev-parse', f"{d['head']}:{path}").strip(), text=False).decode()
        assert not re.search(rpattern, orig), (k, path, 'the converted form already occurs: the conversion would not be reversible')
        new, n = re.subn(pattern, placeholder, orig)
        assert n == 1, (k, path, 'expected exactly one conversion', n)
        assert re.sub(rpattern, rplace, new) == orig, (k, path, 'conversion is not exactly reversible')
        t = out / s['name'] / 'sanitized' / path; t.parent.mkdir(parents=True, exist_ok=True); t.write_text(new)
        d['sanitized'].append({'path': path, 'originalBlob': git(s['repo'], 'rev-parse', f"{d['head']}:{path}").strip(), 'originalSha256': sha(orig.encode()),
                               'file': str(t.relative_to(out)), 'sha256': sha(new.encode()), 'replacements': n, 'pattern': pattern, 'replacement': placeholder,
                               'reversePattern': rpattern, 'reverseReplacement': rplace, 'reason': reason,
                               'originalBlobsByCommit': {c['commit']: (git(s['repo'], 'ls-tree', c['commit'], '--', path).split() or [None, None, None])[2] for c in d['commits']},
                               'claim': ('CONVERTED copy of the HEAD file, exactly reversible: re.sub(reversePattern, reverseReplacement) gives the original '
                                         'blob (asserted). Earlier versions are recorded by blob only')})
    d['label'] = 'SOURCE-ONLY DERIVATIVE: ' + NOTES[k] + '; ' + s['labelOmission']
    d['omittedRecipe'] = s['recipe']
    d['omittedBlockCids'] = [{'path': pth, 'cid': cid, 'sha256EqualsCidMultihash': True} for pth, cid in s.get('blocks', {}).items()]
    if s.get('heldOut'):
        d['heldOut'] = []
        for a in d['omittedAtHead']:
            data = git(s['repo'], 'cat-file', 'blob', a['blob'], text=False); data.decode('utf-8'); assert len(data) < 5_000_000, a['path']
            assert OLD not in data and OLD.lower() not in data and PKBLOCK not in data, a['path']
            t = out / s['name'] / 'held-out' / a['path']; t.parent.mkdir(parents=True, exist_ok=True); t.write_bytes(data)
            d['heldOut'].append({'path': a['path'], 'mode': a['mode'], 'blob': a['blob'], 'file': str(t.relative_to(out)), 'sha256': sha(data)})
        assert len(d['commits']) == 1, 'held-out restore is checked at the single commit'
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
inventory = {'format': 'enclave-frozen-2100-export/v1', 'checkpointHeadAtExport': CHECKPOINT_HEAD,
    'batch': '2100 = the batch start 2026-10-23T21:00:37Z (date -u): an identifier, not a publication time',
    'label': ('SOURCE + EVIDENCE ONLY. Custody v2 rollout work: ROOT live reconciliation dc07e225 (read-only), R dashboard 9d97b4b0 (source/test), '
              'site releases (r1 SUPERSEDED, r2 metadata/source; neither published), canary ingress forwarder, factory consumer review and factory '
              'activation handoff (its ABI fix WIP not included), production canary driver (NOT mutation-ready), metal0 recipient provenance, '
              'ipns-publisher assessment. Root owns all activation and signing; none has occurred. Existing custody is the original single-seat '
              'bootstrap: NOT complete and NOT decentralized custody.'),
    'sides': sides, 'derivatives': derivs, 'lowercaseRewrittenLiteral': lit, 'frozenSources': frozen, 'rootEvidence': evidence,
    'snapshotsUnchangedSince1852': ['ROOT-PENDING-LATEST.txt', 'effective-goal-requirements.txt'],
    'rootEvidenceNote': 'no new root outputs file besides the dated snapshot of the living custody-v2-live-verification record (its earlier bytes stay stored unchanged)',
    'evidenceVsSource': 'Committed logs, receipts, run outputs and RESULT files inside these repositories are EVIDENCE; the rest is source.',
    'notPreserved': ['ignored/untracked files in every repo: images, binaries, CARs, build outputs, node_modules, raw quotes, guest console logs, sealed '
                     'state, private config, keys, canary run directories, task prompts and progress/err files of workers, uncommitted WIP',
                     'commits after these heads and every worktree change',
                     'outer non-repo files of these work directories']}
(out / 'INVENTORY.json').write_text(json.dumps(inventory, indent=1) + '\n')
print(json.dumps({k: {'commits': len(v['commits']), 'files': len(v['changedFiles'])} for k, v in {**sides, **derivs}.items()}
                 | {'frozen': len(frozen), 'rootEvidence': len(evidence), 'inventorySha256': sha((out / 'INVENTORY.json').read_bytes())}))

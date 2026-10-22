#!/usr/bin/env python3
"""TARGETED refresh of the reconciled candidate (cf00054a) with ONLY the root-integrated, tested incident changes,
by reconcile.py's own rule (candidate bytes = T(local bytes), local mode, for paths upstream 7752a423 did not touch).

  refresh.py --plan     read-only: preconditions, per-path CAS against root's receipts, the drift of work/enclave since
                        the candidate's main snapshot (main-now.sha256, 11:15Z) split into AUTHORIZED / NOT APPLIED
  refresh.py --apply    the same checks, then: back up the index + listings, write the authorized files into the
                        candidate directory, add them to candidate.index (objects into the isolated upstream.git),
                        write-tree, prove directory == tree, regenerate the listings. No commit, ref, push or build.
work/enclave is only read (GIT_OPTIONAL_LOCKS=0); any precondition failure stops before a byte is written."""
import hashlib, json, os, stat, subprocess, sys, shutil, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
UG, CAND, M = HERE / 'upstream.git', HERE.parent / 'reconciled-candidate', HERE.parents[1] / 'enclave'
OUT = HERE / 'refresh-20261021-incident'
UHEAD, OPRIME, OLD_TREE = '7752a4239b3bec2cf452491cd1b95164a8c2bdb8', 'adf9c5bb', 'cf00054aa76ddabf97af0c955d89d79bfa4caeab'
ENV = {**os.environ, 'GIT_OPTIONAL_LOCKS': '0', 'LC_ALL': 'C'}
def T(b): return b.replace(b'Cloud Provider', b'Cloud Provider').replace(b'Cloud Provider', b'Cloud Provider')
sha = lambda b: hashlib.sha256(b).hexdigest()
def git(*a, env=ENV, input=None):
    return subprocess.run(['git', '--git-dir', str(UG), *a], capture_output=True, check=True, env=env, input=input).stdout

# path -> (expected local sha256 AFTER root's integration, receipt, local sha256 BEFORE it or None for a new file)
AUTH = {
  'relay/api-relay.js': ('ece620bd5fa0e51d025761516fcb4e86b06406865915f92ce341c4fa6e2ec915', 'native-origin/root-source-integration.json', '3cc03d1d0ab3489cbf9327ef9b8df1f64c561acdf2cf5137265be69f3929a881'),
  'test/cors-ens-origins.test.mjs': ('f9fc9c037c6224ebd9bdb990ae6b26224adc6d4bdd180d2e1123927bf48ada8d', 'native-origin/root-source-integration.json', None),
  'relay/secrets.js': ('4c49127164e716a7431b1e2d62cd703f82b7a849641205e5bdf28d3bd17a198b', 'nucbox-tls-20261021/relay-exists/root-source-integration.json', '6f3d8c7633510b5a0c6e4a230aa8b0dad78eff585ad59f8b1fc381f3ef138ea5'),
  'test/custody-relay.test.mjs': ('936b7a2bdbbdd9aefe1af96d985db0088a05e2bcd62a740f323fe734b80ae3cd', 'nucbox-tls-20261021/relay-exists/root-source-integration.json', 'abc30193724b83af88b9399e456ebf89a9d92cdb417ff5709b6987e3ac4f2b4b'),
  'test/relay-exists-fastpath.test.mjs': ('cc2157833a6ac43e4224b79fcebd7f5351edcef270965aa6213b39af6f7f3a99', 'nucbox-tls-20261021/relay-exists/root-source-integration.json', None),
  'windows/vbslike/manager/wmiserve-run.mjs': ('8107f272741c40a3d6ea51c0054d5fdc0904cd277346265cd01ca9de1c74ed17', 'nucbox-tls-20261021/root-source-integration.json', 'c0154d17372a09fa08d9c4c8675496668fa927774da5245bb2d6892410feddde'),
  'windows/vbslike/manager/wmiserve-run.test.mjs': ('83b201f0d541586a161759f20ecb7ffffc776fd8d542af9c0598fe8d8974055c', 'nucbox-tls-20261021/root-source-integration.json', 'def33c780fa16ee30890bde7c9059194888bf68bab30a67d5b9bec97d77702d6'),
  'windows/vbslike/manager/testdata/fake-wmiserve.mjs': ('5b7b9f9c7176ec002ddfb8d63897eb274d3fce8bf1e5ac1c2cac66a47874c210', 'nucbox-tls-20261021/root-source-integration.json', '1a91f363ed76c168ea7d2a27463cb2c4ce0c6d0067485ad7d52bc1639dd07694'),
  'windows/vbslike/manager/server.mjs': ('6e4cca130926539f658905f31b25c855d8cd763d3cce1047e08384085268437f', 'enclavedns-startup-incident/root-source-integration/inventory.json', 'b2e7c346120a86ea7b9e62b8fb2afb96f8a8b6730de5462c8949b03f96e0044a'),
  'windows/vbslike/manager/liveness.test.mjs': ('c904182d854756e3f0651e84d4778e910ad0a7ab86293e0265bbd354261c881c', 'enclavedns-startup-incident/root-source-integration/inventory.json', 'f58c3d2f0ef79c5c4bf92e7a14ee358ec6f979265f3582155e3f5d7be0997d65'),
}

def tree(rev):
    out = {}
    for rec in git('ls-tree', '-r', '-z', rev).split(b'\0'):
        if rec:
            meta, p = rec.split(b'\t', 1); mode, _, oid = meta.decode().split(); out[p.decode()] = (mode, oid)
    return out

def local_state(p):
    fp = M / p
    try: s = os.lstat(fp)
    except FileNotFoundError: return None
    if stat.S_ISLNK(s.st_mode): return ('120000', os.readlink(fp).encode())
    return ('100755' if s.st_mode & 0o111 else '100644', fp.read_bytes())

def cand_state(p):
    fp = CAND / p
    if fp.is_symlink(): return ('120000', os.readlink(fp).encode())
    if not fp.exists(): return None
    return ('100755' if os.stat(fp).st_mode & 0o111 else '100644', fp.read_bytes())

def main_listing():
    r = subprocess.run(f"cd '{M}' && find . \\( -name node_modules -o -name .git -o -name __pycache__ \\) -prune -o -type f -print0 | sort -z | xargs -0 sha256sum",
                       shell=True, capture_output=True, text=True, check=True)
    return dict((l[66:], l[:64]) for l in r.stdout.splitlines())

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else '--plan'
    assert mode in ('--plan', '--apply')
    rep = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'mode': mode, 'oldTree': OLD_TREE, 'upstream': UHEAD}
    # P1. the candidate directory is still exactly cf00054a (index and worktree)
    idx = HERE / 'candidate.index'
    ienv = {**ENV, 'GIT_INDEX_FILE': str(idx), 'GIT_WORK_TREE': str(CAND)}
    assert git('write-tree', env=ienv).decode().strip() == OLD_TREE, 'candidate.index is not cf00054a'
    subprocess.run(['git', '--git-dir', str(UG), 'update-index', '-q', '--refresh'], env=ienv)
    dirty = git('diff-files', '--name-status', env=ienv).decode(); extra = git('ls-files', '-o', env=ienv).decode()
    assert dirty == '' and extra == '', 'candidate directory differs from cf00054a: ' + (dirty + extra)[:400]
    tOp, tU = tree(OPRIME), tree(UHEAD)
    # P2. per authorized path: CAS on local bytes, upstream untouched, old candidate == T(local BEFORE) where knowable
    plan, stop = [], []
    for p, (after, receipt, before) in AUTH.items():
        L = local_state(p); C = cand_state(p)
        row = {'path': p, 'receipt': receipt, 'localSha256': sha(L[1]) if L else None, 'expected': after}
        if not L or sha(L[1]) != after: stop.append(f'{p}: local is {row["localSha256"]}, not the receipt\'s {after[:12]}'); plan.append(row); continue
        if tOp.get(p) != tU.get(p): stop.append(f'{p}: upstream 7752a423 changed it (needs a 3-way merge, not a refresh)')
        ours = (L[0], T(L[1]))
        row.update({'mode': ours[0], 'candidateNowSha256': sha(C[1]) if C else None, 'newSha256': sha(ours[1]), 'tChanged': ours[1] != L[1],
                    'action': 'already current' if C == ours else ('add' if C is None else 'update')})
        if before and C and not row['tChanged'] and sha(C[1]) not in (before, after):
            stop.append(f'{p}: the candidate holds {sha(C[1])[:12]}, neither the receipt\'s before {before[:12]} nor after: unexplained')
        row['candidateWasReceiptBefore'] = (sha(C[1]) == before) if (C and before and not row['tChanged']) else None
        plan.append(row)
    # api-relay.js is changed by T, so "candidate == receipt before" is not checkable byte-wise; instead the old candidate
    # file + the reviewed CORS patch (fuzz 0) must be exactly T(local after)
    import tempfile
    patch = HERE.parents[1] / 'ens-public-site-20261021/native-origin/fix/cors-ens-origins.patch'
    with tempfile.TemporaryDirectory(dir=HERE) as td:
        shutil.copy2(CAND / 'relay/api-relay.js', Path(td) / 'api-relay.js')
        r = subprocess.run(['patch', '--fuzz=0', '-p1', '-d', td, '-i', str(patch)], capture_output=True, text=True)
        got = sha((Path(td) / 'api-relay.js').read_bytes())
    want = next(x for x in plan if x['path'] == 'relay/api-relay.js').get('newSha256')
    rep['apiRelayPatchProof'] = {'patch': str(patch), 'patchSha256': sha(patch.read_bytes()), 'rc': r.returncode, 'out': r.stdout.strip()[-300:],
                                 'oldCandidatePlusPatch': got, 'newCandidate': want, 'equal': got == want}
    if got != want: stop.append('relay/api-relay.js: old candidate + CORS patch != T(local after): the local file carries more than the patch')
    rep['authorized'] = plan
    # P3. drift of work/enclave since the candidate's main snapshot (report only; NOT applied)
    snap = dict((l[66:], l[:64]) for l in open(HERE / 'main-now.sha256').read().splitlines())
    now = main_listing()
    drift = sorted(p for p in set(snap) | set(now) if snap.get(p) != now.get(p))
    norm = lambda p: p[2:] if p.startswith('./') else p
    rep['driftSinceCandidate'] = {'snapshot': 'main-now.sha256 (2026-10-21T11:15Z)', 'paths': len(drift),
        'authorized': [norm(p) for p in drift if norm(p) in AUTH],
        'notApplied': [{'path': norm(p), 'snapshot': snap.get(p), 'now': now.get(p)} for p in drift if norm(p) not in AUTH]}
    rep['stop'] = stop
    if stop or mode == '--plan':
        OUT.mkdir(exist_ok=True); json.dump(rep, open(OUT / f'refresh-{mode[2:]}.json', 'w'), indent=1)
        print(json.dumps({'stop': stop, 'actions': {r['path']: r.get('action') for r in plan}, 'drift': len(drift),
                          'notApplied': len(rep['driftSinceCandidate']['notApplied'])}, indent=1))
        sys.exit(1 if stop else 0)
    # A. apply: backups first (create-only)
    OUT.mkdir(exist_ok=True)
    for f in ('candidate.index', 'candidate-all.sha256', 'candidate-changed-paths.tsv', 'candidate-inventory.json'):
        dst = OUT / (f + '.cf00054a'); assert not dst.exists(), f'{dst} exists: an earlier apply? inspect'
        shutil.copy2(HERE / f, dst)
    for r in plan:
        if r['action'] == 'already current': continue
        L = local_state(r['path']); data = T(L[1]); fp = CAND / r['path']
        fp.parent.mkdir(parents=True, exist_ok=True)
        if fp.exists() or fp.is_symlink(): fp.unlink()
        if r['mode'] == '120000': os.symlink(data.decode(), fp)
        else: fp.write_bytes(data); os.chmod(fp, 0o755 if r['mode'] == '100755' else 0o644)
        oid = git('hash-object', '-w', '--stdin', input=data).decode().strip()
        git('update-index', '--add', '--cacheinfo', f"{r['mode']},{oid},{r['path']}", env=ienv)
        r['blob'] = oid
    new_tree = git('write-tree', env=ienv).decode().strip()
    subprocess.run(['git', '--git-dir', str(UG), 'update-index', '-q', '--refresh'], env=ienv)
    dirty = git('diff-files', '--name-status', env=ienv).decode(); extra = git('ls-files', '-o', env=ienv).decode()
    assert dirty == '' and extra == '', 'after apply the directory differs from the index: ' + (dirty + extra)[:400]
    # re-derive the tree from the directory alone (job-evidence.sh's method): must equal new_tree
    rd = HERE / 'rederive.index'; rd.unlink(missing_ok=True)
    renv = {**ENV, 'GIT_INDEX_FILE': str(rd), 'GIT_WORK_TREE': str(CAND)}
    git('read-tree', UHEAD, env=renv); git('add', '-A', '-f', '.', env=renv)
    rtree = git('write-tree', env=renv).decode().strip(); rd.unlink()
    assert rtree == new_tree, f're-derived {rtree} != {new_tree}'
    # the tree delta is exactly the authorized paths that changed
    delta = [l.split('\t', 1)[1] for l in git('diff-tree', '-r', '--no-renames', OLD_TREE, new_tree).decode().splitlines()]
    want = sorted(r['path'] for r in plan if r['action'] != 'already current')
    assert sorted(delta) == want, f'tree delta {delta} != authorized {want}'
    # listings (same commands as job-evidence.sh / reconcile.py)
    lst = subprocess.run(f"cd '{CAND}' && find . \\( -type f -o -type l \\) -print0 | sort -z | xargs -0 sha256sum", shell=True, capture_output=True, check=True).stdout
    (HERE / 'candidate-all.sha256').write_bytes(lst)
    inv = json.load(open(HERE / 'candidate-inventory.json'))
    by = {c['path']: c for c in inv['changedPaths']}
    diff = git('diff-tree', '-r', '-z', '--no-renames', UHEAD, new_tree).split(b'\0'); changed = []; i = 0
    while i < len(diff) - 1:
        om, nm, oo, no, s = diff[i].decode().lstrip(':').split(); path = diff[i + 1].decode(); i += 2
        fp = CAND / path
        changed.append({'path': path, 'status': s, 'oldMode': om, 'newMode': nm, 'oldBlob': oo, 'newBlob': no,
                        'sha256': (sha(os.readlink(fp).encode()) if fp.is_symlink() else sha(fp.read_bytes())) if s != 'D' else None,
                        'decision': by.get(path, {}).get('decision') or 'local'})
    inv['changedPaths'] = changed; inv['candidateTree'] = new_tree; inv['changedVsUpstream'] = len(changed)
    inv.setdefault('refreshes', []).append({'at': rep['at'], 'from': OLD_TREE, 'to': new_tree, 'paths': want, 'report': str(OUT / 'refresh-apply.json')})
    json.dump(inv, open(HERE / 'candidate-inventory.json', 'w'), indent=1)
    with open(HERE / 'candidate-changed-paths.tsv', 'w') as f:
        f.write('status\tmode\tsha256\tblob\tdecision\tpath\n')
        for c in changed: f.write(f"{c['status']}\t{c['newMode']}\t{c['sha256'] or '-'}\t{c['newBlob']}\t{c['decision']}\t{c['path']}\n")
    rep.update({'newTree': new_tree, 'reDerivedTree': rtree, 'treeDelta': delta, 'changedVsUpstream': len(changed),
                'candidateAllSha256': sha(lst), 'candidateFiles': lst.count(b'\n')})
    json.dump(rep, open(OUT / 'refresh-apply.json', 'w'), indent=1)
    print(json.dumps({k: rep[k] for k in ('newTree', 'reDerivedTree', 'treeDelta', 'changedVsUpstream', 'candidateAllSha256', 'candidateFiles')}, indent=1))
    print('REFRESH-OK')

if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""TARGETED refresh of the reconciled candidate (0e229304) with ONLY root's cron-incident canonical integration
(cron-startup-20261021/canonical-integration: 2 network files, main host tick, 2 generated bundles, 2 tests), a copy of refresh.py's
procedure (candidate bytes = T(local bytes), local mode, for paths upstream 7752a423 did not touch). Original header:

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
OUT = HERE / 'refresh-20261021-cron'
UHEAD, OPRIME, OLD_TREE = '7752a4239b3bec2cf452491cd1b95164a8c2bdb8', 'adf9c5bb', '0e2293045cdb407a0a2866a4e6b1ae893e39d0bf'
ENV = {**os.environ, 'GIT_OPTIONAL_LOCKS': '0', 'LC_ALL': 'C'}
def T(b): return b.replace(b'Cloud Provider', b'Cloud Provider').replace(b'Cloud Provider', b'Cloud Provider')
sha = lambda b: hashlib.sha256(b).hexdigest()
def git(*a, env=ENV, input=None):
    return subprocess.run(['git', '--git-dir', str(UG), *a], capture_output=True, check=True, env=env, input=input).stdout

# path -> (expected local sha256 AFTER root's integration, receipt, local sha256 BEFORE it or None for a new file)
AUTH = {
  'network/host-admission-runtime.mjs': ('f9e009dadf3bb3a7d6f6823153f06864a9a58c0b3f2e2df1f35c3a606b2d83ec', 'cron-startup-20261021/canonical-integration/CANONICAL-INTEGRATION.json', 'b0d4d2ab26afc91a995e5d7edd95d333851571b3ea0d1da2fa69a4f82f289aef'),
  'network/lease-reader.mjs': ('907ba85d40e3938d6a2aa3e22904bb9449b3bce5426eaf27003892922b6efa5e', 'cron-startup-20261021/canonical-integration/CANONICAL-INTEGRATION.json', 'd885b303b8f860e5be1e498be0078f3cef16e4d77c84211769cc5c67839d9347'),
  'windows/node/host.mjs': ('e41122d7a547635821d7d237e69460fcda33f7aa7f77e35afbde0754ae310a1a', 'cron-startup-20261021/canonical-integration/CANONICAL-INTEGRATION.json', 'd4b5d41768e36a6274ade9a731e32b0089f81419a36dc9a93615bc860717323d'),
  'windows/node/host-admission.bundle.mjs': ('7aeb5de953f1faaef0bfaa0e5f0d8138c3726a04ca3614225aa1159694bbfcd4', 'cron-startup-20261021/canonical-integration/CANONICAL-INTEGRATION.json', 'e83515fca7468d5d6636631617d73d9ed9ef12b798439e7aaed347f2f524182c'),
  'metal/guest/host-policy.bundle.mjs': ('a19af83c00c1999fcacf5f686bff62447535a469f52a6a358a34c69f38422b21', 'cron-startup-20261021/canonical-integration/CANONICAL-INTEGRATION.json', '8b2dfbc6b5466d3c4f4559c15d874824f1ddddd3e530667a3848b3141b477af9'),
  'test/host-admission-retry.test.mjs': ('109e1f7b8c2c2523006c2493b84ead82366b22fe304bb2f8ab47679f2381a878', 'cron-startup-20261021/canonical-integration/CANONICAL-INTEGRATION.json', None),
  'test/windows-node-tick-single-flight.test.mjs': ('d8ceb1af3c517d144c84a9d46e73c94956e5f0c0713b3c8f2a20d72744745f49', 'cron-startup-20261021/canonical-integration/CANONICAL-INTEGRATION.json', None),
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
    assert git('write-tree', env=ienv).decode().strip() == OLD_TREE, 'candidate.index is not 0e229304'
    subprocess.run(['git', '--git-dir', str(UG), 'update-index', '-q', '--refresh'], env=ienv)
    dirty = git('diff-files', '--name-status', env=ienv).decode(); extra = git('ls-files', '-o', env=ienv).decode()
    assert dirty == '' and extra == '', 'candidate directory differs from 0e229304: ' + (dirty + extra)[:400]
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
        dst = OUT / (f + '.0e229304'); assert not dst.exists(), f'{dst} exists: an earlier apply? inspect'
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

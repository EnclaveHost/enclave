#!/usr/bin/env python3
"""ISOLATED reconciled source candidate anchored to current rewritten main (no commit, no push, old tree untouched).

  O  = c2bc3cc6  local origin/main (original history)         -> rewritten as adf9c5bb (proved here: T(O) == adf9c5bb)
  U  = 7752a423  published main (= adf9c5bb + rewritten 166bf9d3 'sso' + PRODUCT/README claims correction)
  L  = work/enclave working tree: e762a9c5 (111 unpublished commits over O) + every nonignored working edit/untracked file
  T  = the two user-authorized literal blob replacements, exactly as the published rewrites applied them to every blob
       (git filter-repo --blob-callback): b'Cloud Provider' -> b'Cloud Provider', b'Cloud Provider' -> b'Cloud Provider'.

Per path in (local changes) U (upstream changes): base T(O), ours T(L), theirs U. Upstream-only -> theirs; local-only ->
ours; both -> equal or a recorded 3-way text merge (git merge-file), else a recorded CONFLICT (stop). Excluded paths are
listed with reasons. Reads only source files and git objects; never opens a path the path inventory flags as sensitive
unless it is reviewed source (SENSITIVE_REVIEWED). Writes ONLY under reconciled-candidate/ and reconciliation/.
"""
import hashlib, json, os, shutil, stat, subprocess, sys, tempfile
from pathlib import Path
HERE = Path(__file__).resolve().parent; W = HERE.parents[1]; M = W/'enclave'; CAND = HERE.parent/'reconciled-candidate'
UPSRC = W/'product-claims-20261021/repo'; UG = HERE/'upstream.git'
O, LHEAD, OPRIME, UHEAD = ('c2bc3cc636ce53719f52688093ea892b9c8639c1', 'e762a9c5f523cf7fcb6d68118ca459290926f8fa',
                           'adf9c5bbf40483f6270048165a55ec7700ea9155', '7752a4239b3bec2cf452491cd1b95164a8c2bdb8')
EXCLUDED_PREFIXES = {'work/host-capacity-integration/': 'integration scratch inside the repo (apply-edits.py, *.patch, '
                     'make-patches.sh, copies of tests); not product source. Left untouched in work/enclave.'}
ENV = {**os.environ, 'GIT_OPTIONAL_LOCKS': '0', 'LC_ALL': 'C'}
def T(b): return b.replace(b'Cloud Provider', b'Cloud Provider').replace(b'Cloud Provider', b'Cloud Provider')
def run(*a, repo=None, input=None, env=None):
    return subprocess.run(['git', *(['--git-dir', str(repo)] if isinstance(repo, Path) and repo.suffix == '.git' else ['-C', str(repo)]), *a],
                          input=input, capture_output=True, check=True, env=env or ENV).stdout
def blobsha(b): return hashlib.sha1(b'blob %d\0' % len(b) + b).hexdigest()
sha256 = lambda b: hashlib.sha256(b).hexdigest()

class Cat:
    def __init__(self, repo):
        args = ['git', '--git-dir', str(repo)] if repo.suffix == '.git' else ['git', '-C', str(repo)]
        self.p = subprocess.Popen(args + ['cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=ENV)
    def __call__(self, oid):
        self.p.stdin.write(oid.encode() + b'\n'); self.p.stdin.flush()
        hdr = self.p.stdout.readline().split()
        if hdr[1] == b'missing': raise KeyError(oid)
        n = int(hdr[2]); data = self.p.stdout.read(n); self.p.stdout.read(1); return data
def tree(repo, rev):
    out = run('ls-tree', '-r', '-z', '--full-tree', rev, repo=repo).split(b'\0')
    r = {}
    for e in out:
        if not e: continue
        meta, path = e.split(b'\t', 1); mode, typ, oid = meta.decode().split()
        if typ != 'blob': raise SystemExit(f'unsupported {typ} at {path!r} in {rev}')
        r[path.decode()] = (mode, oid)
    return r

def main():
    report = {'anchors': {'O': O, 'localHead': LHEAD, 'Oprime': OPRIME, 'upstream': UHEAD}, 'transform': "b'Cloud Provider'->b'Cloud Provider', b'Cloud Provider'->b'Cloud Provider' on every blob (incl. symlink targets), filenames/modes unchanged"}
    for p in (CAND,):
        if p.exists() and any(p.iterdir()): raise SystemExit(f'{p} is not empty; inspect before retry')
    # 1. isolated upstream: shallow file:// clone (depth 3 = 7752 -> 92ea7c9a -> adf9c5bb); the source repo is only read
    if not UG.exists():
        subprocess.run(['git', 'clone', '-q', '--bare', '--depth', '3', '--single-branch', '--branch', 'main', 'file://' + str(UPSRC), str(UG)], check=True, env=ENV)
    assert run('rev-parse', 'main', repo=UG).decode().strip() == UHEAD, 'upstream main is not 7752a423'
    assert run('rev-parse', UHEAD + '~2', repo=UG).decode().strip() == OPRIME, 'adf9c5bb is not 7752~2'
    catU, catL = Cat(UG), Cat(M)
    tO, tOp, tU, tLH = tree(M, O), tree(UG, OPRIME), tree(UG, UHEAD), tree(M, LHEAD)
    # 2. anchor proof: T(O) == O' path-for-path, mode-for-mode, byte-for-byte
    assert set(tO) == set(tOp), 'path sets differ between O and O\''
    tchanged = 0
    for p, (mode, oid) in tO.items():
        mp, op = tOp[p]
        assert mode == mp, ('mode', p)
        assert blobsha(T(catL(oid))) == op, ('T(O) != O\'', p)   # every blob, unchanged ones included
        tchanged += oid != op
    report['anchorProof'] = {'paths': len(tO), 'blobsChangedByT': tchanged, 'result': "T(c2bc3cc6) == adf9c5bb exactly"}
    print('ANCHOR-PROOF T(O)==O\'', len(tO), 'paths', tchanged, 'changed by T', flush=True)
    upstream_changed = sorted(p for p in set(tOp) | set(tU) if tOp.get(p) != tU.get(p))
    # 3. local final state L, from the path inventory (committed O..e762 + working incl. nonignored untracked)
    inv = json.load(open(HERE/'path-inventory.json'))
    local_paths = sorted(p for p, r in inv['paths'].items() if r['committed'] or r['working'])
    excluded, decisions, conflicts, tAffected, headMismatch = [], {}, [], [], []
    def local_state(p):
        fp = M/p
        try: s = os.lstat(fp)
        except FileNotFoundError: return None
        if stat.S_ISLNK(s.st_mode): return ('120000', os.readlink(fp).encode())
        if not stat.S_ISREG(s.st_mode): raise SystemExit(f'unsupported file type at {p}')
        return ('100755' if s.st_mode & 0o111 else '100644', fp.read_bytes())
    final = {}   # path -> (mode, bytes) or None (deleted)
    for p in local_paths:
        ex = next((why for pre, why in EXCLUDED_PREFIXES.items() if p.startswith(pre)), None)
        if ex:
            st = local_state(p); excluded.append({'path': p, 'reason': ex, 'sha256': sha256(st[1]) if st else None, 'mode': st[0] if st else None}); continue
        L = local_state(p)
        r = inv['paths'][p]
        if r['committed'] and not r['working']:
            want = tLH.get(p)
            got = (L[0], blobsha(L[1])) if L else None
            if want != got: headMismatch.append({'path': p, 'head': want, 'worktree': got})
        ours = (L[0], T(L[1])) if L else None
        if L and ours[1] != L[1]:
            tAffected.append({'path': p, 'Cloud Provider': L[1].count(b'Cloud Provider'), 'Cloud Provider': L[1].count(b'Cloud Provider'), 'beforeSha256': sha256(L[1]), 'afterSha256': sha256(ours[1])})
        base = tOp.get(p); theirs = tU.get(p)
        bstate = (base[0], catU(base[1])) if base else None
        if base == theirs:                       # upstream did not touch p
            final[p] = ours; decisions[p] = 'local'
            continue
        tstate = (theirs[0], catU(theirs[1])) if theirs else None
        if ours == tstate: final[p] = ours; decisions[p] = 'both-identical'; continue
        if ours == bstate: final[p] = tstate; decisions[p] = 'upstream (local unchanged after T)'; continue
        # both changed differently: 3-way text merge
        if not (ours and tstate and bstate) or '120000' in (ours[0], tstate[0], bstate[0]) or ours[0] != tstate[0]:
            conflicts.append({'path': p, 'why': 'structural (delete/mode/symlink) on both sides'}); continue
        with tempfile.TemporaryDirectory(dir=HERE) as td:
            fo, fb, ft = (Path(td)/n for n in ('ours', 'base', 'theirs'))
            fo.write_bytes(ours[1]); fb.write_bytes(bstate[1]); ft.write_bytes(tstate[1])
            rc = subprocess.run(['git', 'merge-file', '-p', '-L', 'local', '-L', 'base', '-L', 'upstream', str(fo), str(fb), str(ft)], capture_output=True, env=ENV)
            if rc.returncode != 0:
                (HERE/'conflicts').mkdir(exist_ok=True); (HERE/'conflicts'/(p.replace('/', '__') + '.merge')).write_bytes(rc.stdout)
                conflicts.append({'path': p, 'why': f'text conflict ({rc.returncode} hunks)'}); continue
            merged = rc.stdout
        final[p] = (ours[0], merged)
        decisions[p] = 'merged (clean 3-way: local hunks + upstream hunks)'
        report.setdefault('merges', []).append({'path': p, 'base': sha256(bstate[1]), 'local': sha256(ours[1]), 'upstream': sha256(tstate[1]), 'merged': sha256(merged)})
    for p in upstream_changed:
        if p not in decisions and not any(p.startswith(pre) for pre in EXCLUDED_PREFIXES):
            decisions[p] = 'upstream only'   # tree already carries it
    if conflicts:
        json.dump({**report, 'conflicts': conflicts}, open(HERE/'reconcile-conflicts.json', 'w'), indent=1)
        raise SystemExit(f'CONFLICTS {len(conflicts)}: see reconcile-conflicts.json (nothing materialized)')
    # 4. materialize: upstream tree, then the local final states
    CAND.mkdir(parents=True, exist_ok=True)
    arch = subprocess.Popen(['git', '--git-dir', str(UG), 'archive', UHEAD], stdout=subprocess.PIPE, env=ENV)
    subprocess.run(['tar', '-x', '-C', str(CAND)], stdin=arch.stdout, check=True); arch.wait(); assert arch.returncode == 0
    for p, st in final.items():
        fp = CAND/p
        if fp.is_symlink() or fp.exists():
            if fp.is_dir() and not fp.is_symlink(): raise SystemExit(f'directory in the way at {p}')
            fp.unlink()
        if st is None:
            d = fp.parent
            while d != CAND and d.exists() and not any(d.iterdir()): d.rmdir(); d = d.parent
            continue
        fp.parent.mkdir(parents=True, exist_ok=True)
        mode, data = st
        if mode == '120000': os.symlink(data.decode(), fp)
        else: fp.write_bytes(data); os.chmod(fp, 0o755 if mode == '100755' else 0o644)
    # 5. exact tree object of the candidate (an index under reconciliation/, write-tree; NO commit)
    idx = HERE/'candidate.index'
    if idx.exists(): idx.unlink()
    ienv = {**ENV, 'GIT_INDEX_FILE': str(idx)}
    run('read-tree', UHEAD, repo=UG, env=ienv)
    for p, st in sorted(final.items()):
        if st is None:
            run('update-index', '--force-remove', '--', p, repo=UG, env=ienv); continue
        oid = run('hash-object', '-w', '--stdin', repo=UG, input=st[1]).decode().strip()
        run('update-index', '--add', '--cacheinfo', f'{st[0]},{oid},{p}', repo=UG, env=ienv)
    ctree = run('write-tree', repo=UG, env=ienv).decode().strip()
    # the materialized directory must be exactly that tree (and nothing else, ignored or not)
    weenv = {**ienv, 'GIT_WORK_TREE': str(CAND)}
    subprocess.run(['git', '--git-dir', str(UG), 'update-index', '-q', '--refresh'], env=weenv)
    # worktree vs the candidate index (NOT vs upstream HEAD), and no extra file at all (ignored ones included)
    dirty = subprocess.run(['git', '--git-dir', str(UG), 'diff-files', '--name-status'], capture_output=True, check=True, env=weenv).stdout.decode()
    extra = subprocess.run(['git', '--git-dir', str(UG), 'ls-files', '-o'], capture_output=True, check=True, env=weenv).stdout.decode()
    assert dirty == '' and extra == '', 'candidate directory differs from its tree:\n' + (dirty + extra)[:2000]
    print('CANDIDATE-DIR == CANDIDATE-TREE (no modified, missing or extra file)', flush=True)
    diff = run('diff-tree', '-r', '-z', '--no-renames', UHEAD, ctree, repo=UG).split(b'\0')
    changed = []
    i = 0
    while i < len(diff) - 1:
        meta = diff[i].decode().lstrip(':').split(); path = diff[i+1].decode(); i += 2
        om, nm, oo, no, s = meta
        fp = CAND/path
        changed.append({'path': path, 'status': s, 'oldMode': om, 'newMode': nm, 'oldBlob': oo, 'newBlob': no,
                        'sha256': (sha256(os.readlink(fp).encode()) if fp.is_symlink() else sha256(fp.read_bytes())) if s != 'D' else None,
                        'decision': decisions.get(path)})
    report.update({'candidateTree': ctree, 'candidateDir': str(CAND), 'changedVsUpstream': len(changed),
                   'upstreamChangedPaths': upstream_changed, 'decisionCounts': {}, 'excluded': excluded,
                   'brandTransformAffectedLocalFiles': tAffected, 'committedOnlyPathsWhoseWorktreeDiffersFromHead': headMismatch})
    for d in decisions.values(): report['decisionCounts'][d] = report['decisionCounts'].get(d, 0) + 1
    json.dump({**report, 'changedPaths': changed}, open(HERE/'candidate-inventory.json', 'w'), indent=1)
    with open(HERE/'candidate-changed-paths.tsv', 'w') as f:
        f.write('status\tmode\tsha256\tblob\tdecision\tpath\n')
        for c in changed: f.write(f"{c['status']}\t{c['newMode']}\t{c['sha256'] or '-'}\t{c['newBlob']}\t{c['decision']}\t{c['path']}\n")
    print('CANDIDATE-TREE', ctree, 'changed-vs-7752a423', len(changed), 'excluded', len(excluded), 'T-affected', len(tAffected),
          'merges', len(report.get('merges', [])), 'head-mismatch', len(headMismatch), flush=True)
    print('DECISIONS', json.dumps(report['decisionCounts']))

if __name__ == '__main__':
    main()

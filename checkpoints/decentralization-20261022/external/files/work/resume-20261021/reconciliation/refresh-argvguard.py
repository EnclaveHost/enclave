#!/usr/bin/env python3
"""Targeted refresh of the reconciled candidate with the root-authorized platform-api ARGV-GUARD source fix (3 paths), by
reconcile.py's rule (candidate = T(local bytes), local mode; upstream 7752a423 must not have touched the path) and the
guarded index procedure of refresh.py: CAS 6163e2e7, per-path preimage (candidate == T(reviewed before)), local ==
reviewed after, write, add to candidate.index, write-tree, directory == tree, re-derive, delta == the 3 paths, listings.
  refresh-argvguard.py --plan | --apply        No commit, ref, push or build. work/enclave is only read."""
import hashlib, json, os, subprocess, sys, shutil, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
UG, CAND, M = HERE / 'upstream.git', HERE.parent / 'reconciled-candidate', HERE.parents[1] / 'enclave'
FIX = HERE.parent / 'platform-bundle-smoke' / 'fix'
OUT = HERE / 'refresh-20261021-argvguard'
UHEAD, OPRIME, OLD_TREE = '7752a4239b3bec2cf452491cd1b95164a8c2bdb8', 'adf9c5bb', '6163e2e73667a84f8f93e5870e2f8c923675abdc'
ENV = {**os.environ, 'GIT_OPTIONAL_LOCKS': '0', 'LC_ALL': 'C'}
def T(b): return b.replace(b'Cloud Provider', b'Cloud Provider').replace(b'Cloud Provider', b'Cloud Provider')
sha = lambda b: hashlib.sha256(b).hexdigest()
fsha = lambda p: sha(Path(p).read_bytes()) if Path(p).exists() else None
def git(*a, env=ENV, input=None): return subprocess.run(['git', '--git-dir', str(UG), *a], capture_output=True, check=True, env=env, input=input).stdout
PATHS = ['metal/guest/platform-api-entry.mjs', 'metal/guest/platform-api-role.mjs', 'scripts/build-platform-api-guest-bundle.mjs']

def tree(rev):
    out = {}
    for rec in git('ls-tree', '-r', '-z', rev).split(b'\0'):
        if rec: meta, p = rec.split(b'\t', 1); mode, _, oid = meta.decode().split(); out[p.decode()] = (mode, oid)
    return out

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else '--plan'; assert mode in ('--plan', '--apply')
    rep = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'mode': mode, 'oldTree': OLD_TREE, 'paths': []}
    stop = []
    idx = HERE / 'candidate.index'; ienv = {**ENV, 'GIT_INDEX_FILE': str(idx), 'GIT_WORK_TREE': str(CAND)}
    if git('write-tree', env=ienv).decode().strip() != OLD_TREE: stop.append('candidate.index is not 6163e2e7')
    subprocess.run(['git', '--git-dir', str(UG), 'update-index', '-q', '--refresh'], env=ienv)
    if git('diff-files', '--name-status', env=ienv) or git('ls-files', '-o', env=ienv): stop.append('candidate directory differs from its index')
    tOp, tU = tree(OPRIME), tree(UHEAD)
    for p in PATHS:
        before, after = FIX / 'a' / p, FIX / 'b' / p
        L = M / p
        row = {'path': p, 'reviewedBefore': fsha(before), 'reviewedAfter': fsha(after), 'local': fsha(L), 'candidateBefore': fsha(CAND / p)}
        if row['local'] != row['reviewedAfter']: stop.append(f'{p}: work/enclave is {row["local"]}, not the reviewed after')
        if tOp.get(p) != tU.get(p): stop.append(f'{p}: upstream changed it (needs a merge, not a refresh)')
        want_before = sha(T(before.read_bytes())) if before.exists() else None
        if row['candidateBefore'] != want_before: stop.append(f'{p}: candidate holds {row["candidateBefore"]}, not T(reviewed before) {want_before}')
        data = T(L.read_bytes()) if L.exists() else None
        row.update({'candidateAfter': sha(data) if data is not None else None, 'tChanged': data is not None and data != L.read_bytes(),
                    'mode': '100755' if L.exists() and os.stat(L).st_mode & 0o111 else '100644'})
        rep['paths'].append(row)
    rep['stop'] = stop; OUT.mkdir(exist_ok=True)
    if stop or mode == '--plan':
        json.dump(rep, open(OUT / f'refresh-{mode[2:]}.json', 'w'), indent=1); print(json.dumps(rep, indent=1)); sys.exit(1 if stop else 0)
    for f in ('candidate.index', 'candidate-all.sha256', 'candidate-changed-paths.tsv', 'candidate-inventory.json'):
        dst = OUT / (f + '.6163e2e7'); assert not dst.exists(), f'{dst} exists'; shutil.copy2(HERE / f, dst)
    for r in rep['paths']:
        data = T((M / r['path']).read_bytes()); fp = CAND / r['path']; fp.parent.mkdir(parents=True, exist_ok=True)
        if fp.exists(): fp.unlink()
        fp.write_bytes(data); os.chmod(fp, 0o755 if r['mode'] == '100755' else 0o644)
        oid = git('hash-object', '-w', '--stdin', input=data).decode().strip()
        git('update-index', '--add', '--cacheinfo', f"{r['mode']},{oid},{r['path']}", env=ienv); r['blob'] = oid
    new_tree = git('write-tree', env=ienv).decode().strip()
    subprocess.run(['git', '--git-dir', str(UG), 'update-index', '-q', '--refresh'], env=ienv)
    assert not git('diff-files', '--name-status', env=ienv) and not git('ls-files', '-o', env=ienv), 'directory != index after apply'
    rd = HERE / 'rederive.index'; rd.unlink(missing_ok=True); renv = {**ENV, 'GIT_INDEX_FILE': str(rd), 'GIT_WORK_TREE': str(CAND)}
    git('read-tree', UHEAD, env=renv); git('add', '-A', '-f', '.', env=renv); rtree = git('write-tree', env=renv).decode().strip(); rd.unlink()
    assert rtree == new_tree, (rtree, new_tree)
    delta = sorted(l.split('\t', 1)[1] for l in git('diff-tree', '-r', '--no-renames', OLD_TREE, new_tree).decode().splitlines())
    assert delta == sorted(PATHS), delta
    lst = subprocess.run(f"cd '{CAND}' && find . \\( -type f -o -type l \\) -print0 | sort -z | xargs -0 sha256sum", shell=True, capture_output=True, check=True).stdout
    (HERE / 'candidate-all.sha256').write_bytes(lst)
    inv = json.load(open(HERE / 'candidate-inventory.json')); by = {c['path']: c for c in inv['changedPaths']}
    diff = git('diff-tree', '-r', '-z', '--no-renames', UHEAD, new_tree).split(b'\0'); changed = []; i = 0
    while i < len(diff) - 1:
        om, nm, oo, no, s = diff[i].decode().lstrip(':').split(); path = diff[i + 1].decode(); i += 2
        fp = CAND / path
        changed.append({'path': path, 'status': s, 'oldMode': om, 'newMode': nm, 'oldBlob': oo, 'newBlob': no,
                        'sha256': (sha(os.readlink(fp).encode()) if fp.is_symlink() else fsha(fp)) if s != 'D' else None,
                        'decision': by.get(path, {}).get('decision') or 'local'})
    inv['changedPaths'] = changed; inv['candidateTree'] = new_tree; inv['changedVsUpstream'] = len(changed)
    inv.setdefault('refreshes', []).append({'at': rep['at'], 'from': OLD_TREE, 'to': new_tree, 'paths': PATHS, 'report': str(OUT / 'refresh-apply.json'),
                                            'what': 'platform-api argv-guard source fix (root-authorized); bundle NOT yet rebuilt in this step'})
    json.dump(inv, open(HERE / 'candidate-inventory.json', 'w'), indent=1)
    with open(HERE / 'candidate-changed-paths.tsv', 'w') as f:
        f.write('status\tmode\tsha256\tblob\tdecision\tpath\n')
        for c in changed: f.write(f"{c['status']}\t{c['newMode']}\t{c['sha256'] or '-'}\t{c['newBlob']}\t{c['decision']}\t{c['path']}\n")
    rep.update({'newTree': new_tree, 'reDerivedTree': rtree, 'treeDelta': delta, 'changedVsUpstream': len(changed), 'candidateAllSha256': sha(lst), 'candidateFiles': lst.count(b'\n'),
                'finishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()})
    json.dump(rep, open(OUT / 'refresh-apply.json', 'w'), indent=1)
    print(json.dumps({k: rep[k] for k in ('newTree', 'reDerivedTree', 'treeDelta', 'changedVsUpstream', 'candidateAllSha256', 'candidateFiles', 'finishedAt')}, indent=1)); print('ARGVGUARD-REFRESH-OK')

if __name__ == '__main__':
    main()

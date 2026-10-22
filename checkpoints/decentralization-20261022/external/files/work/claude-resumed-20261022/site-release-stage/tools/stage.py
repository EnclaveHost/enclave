#!/usr/bin/env python3
"""stage.py: the ISOLATED site-closure stage (run once, through the queue). No build, no network, no commit.
 1. src/ = the ENUMERATED site build + release-tool closure of the reconciled candidate, real files with their modes; each
    file's git blob and mode must equal the candidate's recorded tree cf00054a (upstream.git, read-only).
 2. src/node_modules = a real-file copy (reflink when possible) of work/enclave/node_modules; it is verified file-by-file
    against the source; its 10 symlinks are relative and stay inside the copy.
 3. inventory/before.json, then the ACCEPTED media patch 04836638 (patch -p1, no fuzz), whose 5 results must equal
    ROOT-REVIEW.json's src hashes, then inventory/after.json (closure files; node_modules as its own manifest).
 4. The private git view for the build stamp: GIT_DIR=<bare upstream.git> GIT_WORK_TREE=src GIT_INDEX_FILE=git/index,
    GIT_OPTIONAL_LOCKS=0, `git read-tree 7752a4239` into the PRIVATE index only. The bare repository's HEAD, config,
    packed-refs and refs are fingerprinted before and after and must be unchanged. The stamp is then
    `git rev-parse --short=8 HEAD` (+"*" because the stage worktree differs from main)."""
import hashlib, json, os, shutil, stat, subprocess, sys
W = '/home/steven/Documents/Codex/2026-10-18/wo/work'
CAND = f'{W}/resume-20261021/reconciled-candidate'; NM = f'{W}/enclave/node_modules'
BARE = f'{W}/resume-20261021/reconciliation/upstream.git'; TREE = 'cf00054aa76ddabf97af0c955d89d79bfa4caeab'; MAIN = '7752a4239b3bec2cf452491cd1b95164a8c2bdb8'
D = os.path.abspath(os.path.join(os.path.dirname(__file__), '..')); SRC = f'{D}/src'
PATCH = f'{D}/inputs/media-fallback.04836638.patch'; REVIEW = f'{D}/inputs/media-ROOT-REVIEW.json'
CONTRACTS = ['EnclaveAddressBook', 'EnclaveRegistry', 'EnclaveAppCatalog', 'EnclavePay', 'EnclaveDeployments', 'EnclaveConnectivity', 'EnclaveProofOfTime',
             'EnclaveAvailability', 'EnclaveVerificationFees', 'EnclaveFeatured', 'EnclaveReviews', 'EnclaveHostReviews', 'PaymentRouter', 'EnclaveCreditVault']
FILES = ['scripts/build-site.mjs', 'scripts/site-built-in-profile.mjs', 'scripts/build-contract-artifacts.mjs', 'THIRD-PARTY-NOTICES.md', 'package.json',
         'package-lock.json', 'cli/install.sh', 'cli/install.ps1', 'cli/host.ps1', 'network/host-liveness.mjs', 'network/host-policy-mirrors.mjs',
         'network/network-policy-core.mjs', 'network/canonical.mjs', 'network/wg-config.mjs'] + [f'contracts/{c}.sol' for c in CONTRACTS]
DIRS = ['site', 'scripts/site-release']                      # every file under these (site/dist and node_modules excluded: none exist)
ENV = {**os.environ, 'GIT_OPTIONAL_LOCKS': '0'}
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
blob = lambda p: hashlib.sha1(b'blob %d\0' % os.path.getsize(p) + open(p, 'rb').read()).hexdigest()

def closure():
    out = list(FILES)
    for d in DIRS:
        for r, ds, fs in os.walk(f'{CAND}/{d}'):
            ds[:] = [x for x in ds if x not in ('dist', 'node_modules')]
            out += [os.path.relpath(os.path.join(r, f), CAND) for f in fs]
    return sorted(set(out))

def inventory(paths):
    return {p: {'sha256': sha(f'{SRC}/{p}'), 'mode': oct(stat.S_IMODE(os.lstat(f'{SRC}/{p}').st_mode))} for p in paths}

def bare_fingerprint():
    fp = {}
    for r, ds, fs in os.walk(BARE):
        ds[:] = [x for x in ds if x != 'objects']
        for f in fs:
            p = os.path.join(r, f); fp[os.path.relpath(p, BARE)] = sha(p)
    return fp

def main():
    if os.path.exists(SRC): sys.exit('src/ exists: a fresh stage only')
    tree = {}
    for line in subprocess.run(['git', f'--git-dir={BARE}', 'ls-tree', '-r', '--full-tree', TREE], capture_output=True, text=True, env=ENV, check=True).stdout.splitlines():
        meta, path = line.split('\t', 1); mode, typ, b = meta.split(); tree[path] = (mode, b)
    paths = closure(); prov = []
    for p in paths:
        s = f'{CAND}/{p}'
        if os.path.islink(s): sys.exit(f'{p} is a symlink in the candidate')
        if p not in tree: sys.exit(f'{p} is not in the recorded candidate tree {TREE[:8]}')
        want_mode = '100755' if os.stat(s).st_mode & 0o111 else '100644'
        if tree[p] != (want_mode, blob(s)): prov.append(p)
        os.makedirs(os.path.dirname(f'{SRC}/{p}'), exist_ok=True); shutil.copy2(s, f'{SRC}/{p}')
    if prov: sys.exit(f'candidate files differ from tree {TREE[:8]}: {prov[:5]}')
    # node_modules: real-file copy, verified
    subprocess.run(['cp', '-a', '--reflink=auto', NM, f'{SRC}/node_modules'], check=True)
    nm, links, bad = {}, {}, []
    for r, ds, fs in os.walk(NM):
        for x in ds + fs:
            s = os.path.join(r, x); rel = os.path.relpath(s, NM); t = f'{SRC}/node_modules/{rel}'
            if os.path.islink(s):
                links[rel] = os.readlink(s)
                if os.readlink(t) != os.readlink(s) or os.path.isabs(os.readlink(t)) or not os.path.realpath(t).startswith(f'{SRC}/node_modules/'): bad.append(rel)
            elif os.path.isfile(s):
                h = sha(s); nm[rel] = h
                if os.path.islink(t) or sha(t) != h or stat.S_IMODE(os.stat(t).st_mode) != stat.S_IMODE(os.stat(s).st_mode): bad.append(rel)
    if bad: sys.exit(f'node_modules copy differs: {bad[:5]}')
    nm_manifest = {'files': len(nm), 'symlinks': links, 'treeSha256': hashlib.sha256(json.dumps(nm, sort_keys=True).encode()).hexdigest()}
    json.dump(nm_manifest, open(f'{D}/inventory/node_modules.json', 'w'), indent=1)
    before = inventory(paths); json.dump(before, open(f'{D}/inventory/before.json', 'w'), indent=1)
    # the accepted media patch
    subprocess.run(['patch', '-p1', '--forward', '--fuzz=0', '--no-backup-if-mismatch', '-r', '-', '-d', SRC, '-i', PATCH], check=True)
    after = inventory(paths); json.dump(after, open(f'{D}/inventory/after.json', 'w'), indent=1)
    rv = json.load(open(REVIEW)); changed = sorted(p for p in paths if before[p] != after[p])
    if changed != sorted(rv['files']): sys.exit(f'the patch changed {changed}, not exactly the reviewed 5')
    for p, h in rv['files'].items():
        if before[p]['sha256'] != h['ref'] or after[p]['sha256'] != h['src']: sys.exit(f'{p}: pins differ from ROOT-REVIEW')
    # the private git view
    fp0 = bare_fingerprint()
    genv = {**ENV, 'GIT_DIR': BARE, 'GIT_WORK_TREE': SRC, 'GIT_INDEX_FILE': f'{D}/git/index'}
    subprocess.run(['git', 'read-tree', MAIN], env=genv, check=True)
    head = subprocess.run(['git', 'rev-parse', '--short=8', 'HEAD'], env=genv, capture_output=True, text=True, check=True).stdout.strip()
    full = subprocess.run(['git', 'rev-parse', 'HEAD'], env=genv, capture_output=True, text=True, check=True).stdout.strip()
    porcelain = subprocess.run(['git', 'status', '--porcelain'], env=genv, cwd=SRC, capture_output=True, text=True, check=True).stdout
    fp1 = bare_fingerprint()
    if fp0 != fp1: sys.exit('the bare repository changed')
    res = {'closureFiles': len(paths), 'provenance': f'every file == tree {TREE} blob+mode', 'nodeModules': {k: v for k, v in nm_manifest.items() if k != 'symlinks'} | {'symlinks': len(links)},
           'patch': {'sha256': sha(PATCH), 'changed': changed, 'pinsMatchRootReview': True},
           'git': {'HEAD': full, 'stamp': head + ('*' if porcelain.strip() else ''), 'statusLines': len(porcelain.splitlines()), 'bareUnchanged': True, 'privateIndex': f'{D}/git/index'},
           'inventory': {'before': sha(f'{D}/inventory/before.json'), 'after': sha(f'{D}/inventory/after.json'), 'nodeModules': sha(f'{D}/inventory/node_modules.json')}}
    json.dump(res, open(f'{D}/inventory/stage-result.json', 'w'), indent=1); print(json.dumps(res, indent=1))

if __name__ == '__main__': main()

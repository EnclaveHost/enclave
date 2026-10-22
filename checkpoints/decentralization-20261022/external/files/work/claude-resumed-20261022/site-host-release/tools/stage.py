#!/usr/bin/env python3
"""stage.py: the site-host source stage for release bafybeifkfgxsjz6… (run once, through the queue). No build, no network.
 1. site-host/ = the 20 source files of the REVIEWED recovery component (work/site-host-recovery-release/site-host), real
    copies with modes; each must equal that component's recorded dist/SOURCE.sha256 (digest 573b0943, the source of the
    frozen wasm 4044ea81) and work/enclave-apps/site-host (root's integration). target/, dist/, release/ are not copied.
 2. release.lock.json is the ONLY changed file: CID, CAR sha256 and bytes from the immutable release's release.json,
    re-checked against the CAR bytes themselves.
 3. cargo-home/ = a PRIVATE, offline cargo home holding exactly the crates Cargo.lock names: each .crate copied from
    ~/.cargo/registry/cache and its sha256 checked against Cargo.lock's checksum, plus the sparse-index cache entries and
    config.json. ~/.cargo is only read. build.sh remaps CARGO_HOME to /cargo, so the wasm is the same as from ~/.cargo.
 4. inventory/ = before (the reviewed source) / after (the stage) sha256 + mode, the cargo-home manifest, stage-result.
 The frozen recovery package (its deliver/FINAL.sha256) and the release dir are fingerprinted before and after."""
import hashlib, json, os, shutil, stat, subprocess, sys
W = '/home/steven/Documents/Codex/2026-10-18/wo/work'
REC = f'{W}/site-host-recovery-release'; RSRC = f'{REC}/site-host'; INTEG = f'{W}/enclave-apps/site-host'
CID = 'bafybeifkfgxsjz6gnj234fvdkxa37pc4fcevydu6tb55wtidjejfsuxake'
REL = f'{W}/claude-resumed-20261022/site-release-stage/release/{CID}'
D = os.path.abspath(os.path.join(os.path.dirname(__file__), '..')); SH = f'{D}/site-host'; CH = f'{D}/cargo-home'
REG = os.path.expanduser('~/.cargo/registry'); IDX = 'index.crates.io-1949cf8c6b5b557f'
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
mode = lambda p: oct(stat.S_IMODE(os.lstat(p).st_mode))

def tree_digest(root):
    h = hashlib.sha256()
    for r, ds, fs in os.walk(root):
        ds.sort()
        for f in sorted(fs):
            p = os.path.join(r, f); h.update(f'{sha(p)}  {os.path.relpath(p, root)}\n'.encode())
    return h.hexdigest()

def index_rel(name):
    n = name.lower()
    return {1: f'1/{n}', 2: f'2/{n}', 3: f'3/{n[0]}/{n}'}.get(len(n), f'{n[:2]}/{n[2:4]}/{n}')

def main():
    for p in (SH, CH, f'{D}/inventory'):
        if os.path.exists(p): sys.exit(f'{p} exists: a fresh stage only')
    os.makedirs(f'{D}/inventory')
    frozen0 = subprocess.run(['sha256sum', '-c', '--quiet', 'deliver/FINAL.sha256'], cwd=REC).returncode
    rel0 = tree_digest(REL)
    # 1. the reviewed source
    want = {}
    for line in open(f'{RSRC}/dist/SOURCE.sha256'):
        h, p = line.rstrip('\n').split('  ', 1); want[p] = h
    if hashlib.sha256(open(f'{RSRC}/dist/SOURCE.sha256', 'rb').read()).hexdigest() != '573b09437b649bb0c0a2194286467ab1845339754df2442f6c6305a88664c0c8':
        sys.exit('the recovery SOURCE.sha256 is not the frozen 573b0943 list')
    before, prov = {}, []
    for p, h in sorted(want.items()):
        s = f'{RSRC}/{p}'
        if os.path.islink(s) or sha(s) != h: prov.append(p); continue
        if p != 'release.lock.json' and (not os.path.isfile(f'{INTEG}/{p}') or sha(f'{INTEG}/{p}') != h): prov.append('integ:' + p)
        os.makedirs(os.path.dirname(f'{SH}/{p}'), exist_ok=True); shutil.copy2(s, f'{SH}/{p}')
        before[p] = {'sha256': h, 'mode': mode(s)}
    if prov: sys.exit(f'source differs from the reviewed list: {prov}')
    # 2. the lock
    m = json.load(open(f'{REL}/release.json'))
    car = f'{REL}/site.car'
    if m['cid'] != CID or os.path.getsize(car) != m['car']['bytes'] or sha(car) != m['car']['sha256']: sys.exit('release.json and site.car disagree')
    lock = {'schema': 'site-host-release-lock/1', 'cid': m['cid'], 'car': {'sha256': m['car']['sha256'], 'bytes': m['car']['bytes']},
            'provenance': (f"enclave site release prepared by `scripts/site-release/cli.mjs prepare` from published main {m['source']['commit']} "
                           "(dirty: the reconciled candidate's site closure, tree cf00054a, + media fallback 04836638 + verified config read bad58bd8; "
                           f"work/claude-resumed-20261022/site-release-stage); base {m['base']}")}
    open(f'{SH}/release.lock.json', 'w').write(json.dumps(lock, indent=2) + '\n')
    after = {p: {'sha256': sha(f'{SH}/{p}'), 'mode': mode(f'{SH}/{p}')} for p in before}
    changed = sorted(p for p in before if before[p] != after[p])
    if changed != ['release.lock.json']: sys.exit(f'changed {changed}, not exactly release.lock.json')
    # 3. the private cargo home
    pk, cur = [], {}
    for line in open(f'{SH}/Cargo.lock'):
        line = line.strip()
        if line == '[[package]]': cur = {}; pk.append(cur)
        elif ' = ' in line and pk: k, v = line.split(' = ', 1); cur[k] = v.strip('"')
    crates = [x for x in pk if 'checksum' in x]
    if not all(x.get('source') == 'registry+https://github.com/rust-lang/crates.io-index' for x in crates): sys.exit('a crate is not from crates.io')
    os.makedirs(f'{CH}/registry/cache/{IDX}'); os.makedirs(f'{CH}/registry/index/{IDX}')
    shutil.copy2(f'{REG}/index/{IDX}/config.json', f'{CH}/registry/index/{IDX}/config.json')
    cm, bad = {}, []
    for x in crates:
        f = f"{x['name']}-{x['version']}.crate"; s = f'{REG}/cache/{IDX}/{f}'
        if not os.path.isfile(s) or sha(s) != x['checksum']: bad.append(f); continue
        shutil.copy2(s, f'{CH}/registry/cache/{IDX}/{f}'); cm[f'registry/cache/{IDX}/{f}'] = x['checksum']
        ir = f'.cache/{index_rel(x["name"])}'; si = f'{REG}/index/{IDX}/{ir}'
        if not os.path.isfile(si): bad.append('index:' + x['name']); continue
        os.makedirs(os.path.dirname(f'{CH}/registry/index/{IDX}/{ir}'), exist_ok=True); shutil.copy2(si, f'{CH}/registry/index/{IDX}/{ir}')
        cm[f'registry/index/{IDX}/{ir}'] = sha(si)
    if bad: sys.exit(f'crates missing or not matching Cargo.lock: {bad}')
    cm[f'registry/index/{IDX}/config.json'] = sha(f'{CH}/registry/index/{IDX}/config.json')
    json.dump(before, open(f'{D}/inventory/source-before.json', 'w'), indent=1)
    json.dump(after, open(f'{D}/inventory/source-after.json', 'w'), indent=1)
    json.dump(cm, open(f'{D}/inventory/cargo-home.json', 'w'), indent=1, sort_keys=True)
    frozen1 = subprocess.run(['sha256sum', '-c', '--quiet', 'deliver/FINAL.sha256'], cwd=REC).returncode
    rel1 = tree_digest(REL)
    if frozen0 != 0 or frozen1 != 0 or rel0 != rel1: sys.exit('the frozen recovery package or the release changed / does not verify')
    res = {'sourceFiles': len(after), 'changed': changed, 'lock': lock, 'lockSha256': sha(f'{SH}/release.lock.json'),
           'reviewedSourceDigest': '573b0943 (== enclave-apps/site-host except release.lock.json)',
           'crates': len(crates), 'cargoHomeFiles': len(cm), 'releaseTreeDigest': rel0, 'frozenRecoveryVerifies': True,
           'inventory': {k: sha(f'{D}/inventory/{k}.json') for k in ('source-before', 'source-after', 'cargo-home')}}
    json.dump(res, open(f'{D}/inventory/stage-result.json', 'w'), indent=1); print(json.dumps(res, indent=1))

if __name__ == '__main__': main()

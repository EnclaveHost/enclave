"""Prove the frozen-2217 patches reproduce every recorded tree, offline, from PUSHED checkpoint material (dfb4b55e), in throwaway bare
repos with a temporary index ("2217" = the batch start 2026-10-23T22:17:46Z, an identifier). Bases are rebuilt from the stored patch chains:
custody-live from the frozen-1852/1951/2025/2100/2146 chains; recipient-restore, recipient-activation and proof-app from their frozen-2146
root chains. boot-source is PATCH-ONLY (check_patch_only). Writes source-preservation/frozen-2217-export/REPRODUCE-CHECK.txt."""
from pathlib import Path
import json, os, subprocess, tempfile
root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
checkpoint = root / 'work/source-checkpoint-20261022/main-repo'
CK = 'dfb4b55e627ebd95b647abebf09627296f099862'
STORED = 'checkpoints/decentralization-20261022/closeout-followup/files/'
out = base / 'source-preservation/frozen-2217-export'
inv = json.loads((out / 'INVENTORY.json').read_text())
EMPTY = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
report = []
def stored(rel): return subprocess.run(['git', '-C', str(checkpoint), 'show', f'{CK}:{STORED}{rel}'], check=True, capture_output=True).stdout
J = lambda rel: json.loads(stored(rel))
X = lambda n: f'source-preservation/frozen-{n}-export/'
f1852, f1951, f2025, f2100, f2146 = (J(X(n) + 'INVENTORY.json') for n in ('1852', '1951', '2025', '2100', '2146'))
P = lambda prefix, side: [prefix + p['file'] for p in side['patches']]
s, d = inv['sides'], inv['derivatives']
j = f2146['sides']
assert j['custody-live5']['head'] == s['custody-live6']['base'] and j['recipient-restore']['head'] == s['recipient-restore2']['base'] \
    and j['recipient-activation']['head'] == s['recipient-activation2']['base'] and j['proof-app']['head'] == s['proof-app2']['base']
assert j['custody-live5']['base'] == f2100['sides']['custody-live4']['head'] and all(j[k]['base'] is None for k in ('recipient-restore', 'recipient-activation', 'proof-app'))
CL = (P(X('1852'), f1852['sides']['custody-live']) + P(X('1951'), f1951['sides']['custody-live2']) + P(X('2025'), f2025['sides']['custody-live3'])
      + P(X('2100'), f2100['sides']['custody-live4']) + P(X('2146'), j['custody-live5']))
BASES = {'custody-live6': (None, CL, j['custody-live5']['headTree']),
         'recipient-restore2': (None, P(X('2146'), j['recipient-restore']), j['recipient-restore']['headTree']),
         'recipient-activation2': (None, P(X('2146'), j['recipient-activation']), j['recipient-activation']['headTree']),
         'proof-app2': (None, P(X('2146'), j['proof-app']), j['proof-app']['headTree'])}
for k in {**s, **d}:
    BASES.setdefault(k, (None, [], EMPTY))
def repo(tmp):
    env = {**os.environ, 'GIT_DIR': str(tmp / 'r.git'), 'GIT_INDEX_FILE': str(tmp / 'index'), 'GIT_CONFIG_NOSYSTEM': '1'}
    run = lambda *a, **kw: subprocess.run(['git', '-c', 'gc.auto=0', *a], env=env, cwd=tmp, check=True, capture_output=True, **kw)
    run('init', '-q', '--bare', str(tmp / 'r.git')); (tmp / 'r.git/objects/info/alternates').write_text(f'{checkpoint}/.git/objects\n')
    return run
def check(name, side):
    start, steps, want = BASES[name]
    with tempfile.TemporaryDirectory(prefix='frozen-2217-verify-') as tmp:
        tmp = Path(tmp); run = repo(tmp)
        run('read-tree', start) if start else run('read-tree', '--empty')
        for i, what in enumerate(steps):
            pf = tmp / f'prior-{i}.patch'; pf.write_bytes(stored(what)); run('apply', '--cached', '--whitespace=nowarn', str(pf))
        tree = run('write-tree').stdout.decode().strip(); ok = tree == want
        report.append(f"{name} base rebuilt from {(start or 'empty')[:9]} + {len(steps)} stored patch(es) in {CK[:9]}: tree {tree} {'OK' if ok else 'MISMATCH want ' + want}")
        patches = iter(side['patches'])
        for commit in side['commits']:
            if commit.get('emptyAfterExclusion'):
                good = tree == commit['tree']; ok &= good
                report.append(f"{name} {commit['commit'][:9]}: excluded-paths-only commit, derived tree {tree} {'unchanged OK' if good else 'MISMATCH want ' + commit['tree']}")
                continue
            run('apply', '--cached', '--whitespace=nowarn', str(out / next(patches)['file']))
            tree = run('write-tree').stdout.decode().strip(); good = tree == commit['tree']; ok &= good
            report.append(f"{name} {commit['commit'][:9]}: tree {tree} {'OK' if good else 'MISMATCH want ' + commit['tree']}")
        assert next(patches, None) is None, f'{name}: unused patches'
        if side.get('heldOut'):   # byte-exact files held out of an over-limit patch: add them back -> the ORIGINAL tree
            for hf in side['heldOut']:
                blob = run('hash-object', '-w', str(out / hf['file'])).stdout.decode().strip(); good = blob == hf['blob']; ok &= good
                run('update-index', '--add', '--cacheinfo', f"{hf['mode']},{blob},{hf['path']}")
                report.append(f"{name} held-out {hf['path']}: blob {blob[:9]} {'OK' if good else 'MISMATCH want ' + hf['blob']}")
            orig = run('write-tree').stdout.decode().strip(); good = orig == side['originalHeadTree']; ok &= good
            report.append(f"{name} ORIGINAL head tree with held-out files restored: {orig} {'OK (exact)' if good else 'MISMATCH want ' + side['originalHeadTree']}")
        if side.get('sanitized'):   # converted copies: reverse the substitution, add the original bytes back -> the ORIGINAL tree
            import re
            modes = {a['path']: a['mode'] for a in side['omittedAtHead']}
            for c in side['sanitized']:
                orig = re.sub(c['reversePattern'], c['reverseReplacement'], (out / c['file']).read_text())
                of = tmp / 'restored.tmp'; of.write_text(orig)
                blob = run('hash-object', '-w', str(of)).stdout.decode().strip(); good = blob == c['originalBlob']; ok &= good
                run('update-index', '--add', '--cacheinfo', f"{modes[c['path']]},{blob},{c['path']}")
                report.append(f"{name} converted {c['path']} reversed: blob {blob[:9]} {'OK (original bytes)' if good else 'MISMATCH want ' + c['originalBlob']}")
            orig_tree = run('write-tree').stdout.decode().strip(); good = orig_tree == side['originalHeadTree']; ok &= good
            report.append(f"{name} ORIGINAL head tree with the converted file reversed: {orig_tree} {'OK (exact)' if good else 'MISMATCH want ' + side['originalHeadTree']}")
        return ok and tree == side['headTree']
def check_touched(name, side):
    # base index = ONLY the stored base files of the touched paths; each patch must apply and give the recorded blob for every touched path
    with tempfile.TemporaryDirectory(prefix='frozen-2217-verify-') as tmp:
        tmp = Path(tmp); run = repo(tmp); run('read-tree', '--empty'); ok = True
        for b in side['baseFiles']:
            blob = run('hash-object', '-w', str(out / b['file'])).stdout.decode().strip(); good = blob == b['blob']; ok &= good
            run('update-index', '--add', '--cacheinfo', f"{b['mode']},{blob},{b['path']}")
            report.append(f"{name} base file {b['path']}: blob {blob[:9]} {'OK' if good else 'MISMATCH want ' + b['blob']}")
        patches = iter(side['patches'])
        for commit in side['commits']:
            run('apply', '--cached', '--whitespace=nowarn', str(out / next(patches)['file']))
            want = {e['path']: e['blob'] for e in commit['touchedBlobs']}; got = {}
            for p in want:
                r = subprocess.run(['git', 'ls-files', '-s', '--', p], env={**os.environ, 'GIT_DIR': str(tmp / 'r.git'), 'GIT_INDEX_FILE': str(tmp / 'index')},
                                   cwd=tmp, capture_output=True, text=True, check=True).stdout.split()
                got[p] = r[1] if r else None
            good = got == want; ok &= good
            report.append(f"{name} {commit['commit'][:9]}: {len(got)} touched path blobs {'OK' if good else 'MISMATCH ' + json.dumps({p: (got[p], want[p]) for p in got if got[p] != want[p]})}")
        assert next(patches, None) is None, f'{name}: unused patches'
        report.append(f"{name}: full tree {side['headTree'][:9]} on base {side['base'][:9]} NOT reproduced (base not in pushed material; see baseTreeNotReproduced)")
        return ok
def check_patch_only(name, side):
    # patch-only side: (1) stored base files + the patch restricted to those paths give the recorded head blobs; (2) for every held-back
    # path the patch's index line names exactly the recorded base/head blobs; (3) the held-back base is pinned to pushed material
    with tempfile.TemporaryDirectory(prefix='frozen-2217-verify-') as tmp:
        tmp = Path(tmp); run = repo(tmp); run('read-tree', '--empty'); ok = True
        for b in side['baseFiles']:
            blob = run('hash-object', '-w', str(out / b['file'])).stdout.decode().strip(); good = blob == b['blob']; ok &= good
            run('update-index', '--add', '--cacheinfo', f"{b['mode']},{blob},{b['path']}")
            report.append(f"{name} base file {b['path']}: blob {blob[:9]} {'OK' if good else 'MISMATCH want ' + b['blob']}")
        pf = out / side['patches'][0]['file']; body = pf.read_bytes()
        run('apply', '--cached', '--whitespace=nowarn', *[f"--include={b['path']}" for b in side['baseFiles']], str(pf))
        env = {**os.environ, 'GIT_DIR': str(tmp / 'r.git'), 'GIT_INDEX_FILE': str(tmp / 'index')}
        for t in side['touched']:
            if t['path'] in side['heldBackForRewrittenLiteral']:
                good = f"index {t['baseBlob']}..{t['headBlob']}".encode() in body; ok &= good
                report.append(f"{name} {t['path']}: held back (rewritten literal); patch index names {t['baseBlob'][:9]}..{t['headBlob'][:9]} {'OK' if good else 'MISSING'}")
                continue
            got = subprocess.run(['git', 'ls-files', '-s', '--', t['path']], env=env, cwd=tmp, capture_output=True, text=True, check=True).stdout.split()
            good = bool(got) and got[1] == t['headBlob']; ok &= good
            report.append(f"{name} {t['path']}: base + patch -> head blob {got[1][:9] if got else None} {'OK' if good else 'MISMATCH want ' + t['headBlob']}")
        pin = side['patchProvenance']['supervisorBasePinnedTo']
        inv_ = json.loads(subprocess.run(['git', '-C', str(checkpoint), 'show', f"{CK}:{pin['pushedInventory']}"], check=True, capture_output=True).stdout)
        sha_pushed = next(m['sha256'] for m in inv_['members'] if m['path'] == pin['member'])
        sup = next(t for t in side['touched'] if t['path'] == 'supervisor.js')
        good = sha_pushed == sup['baseSha256'] == pin['sha256']; ok &= good
        report.append(f"{name} supervisor.js base sha256 {sup['baseSha256'][:12]} == pushed production {pin['member']} {'OK' if good else 'MISMATCH'}")
        report.append(f"{name}: full tree {side['headTree'][:9]} NOT reproduced (patch-only; parent and supervisor.js carry the rewritten literal)")
        return ok
results = {k: (check_patch_only(k, v) if v.get('patchOnly') else check_touched(k, v) if 'baseFiles' in v else check(k, v)) for k, v in {**s, **d}.items()}
for k in [k for k in d if not d[k].get('heldOut') and not d[k].get('sanitized')]:
    report.append(f'{k} trees are the ORIGINAL trees minus {d[k]["excluded"]} held at the base (head original {d[k]["originalHeadTree"][:9]}); exact originals NOT reproduced')
report.append('RESULT ' + ', '.join(f'{k} reproduced: {v}' + (' (patch-only)' if ({**s, **d}[k]).get('patchOnly') else ' (touched files only)' if 'baseFiles' in ({**s, **d}[k]) else '') for k, v in results.items()))
(out / 'REPRODUCE-CHECK.txt').write_text('\n'.join(report) + '\n'); print('\n'.join(report))
raise SystemExit(0 if all(results.values()) else 1)

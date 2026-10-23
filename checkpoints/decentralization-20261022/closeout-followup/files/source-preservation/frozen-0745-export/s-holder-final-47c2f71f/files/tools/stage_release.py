#!/usr/bin/env python3
"""Download the pinned Base v1.5.1 x86_64 release tarball (plus its .sha256 and .asc sidecars) into a NEW staging dir,
verify size + digest against the recorded GitHub release metadata, and extract ONLY the regular-file member `base`.
No install scripts, no other member, no links. Cap: 1 GiB total download. Usage: stage_release.py RELEASE_JSON OUTDIR"""
import hashlib, json, os, sys, tarfile, urllib.request
REL, OUT = sys.argv[1], sys.argv[2]
NAME = 'base-v1.5.1-x86_64-unknown-linux-gnu.tar.gz'
CAP = 1 << 30
MEMBER_MAX = 512 << 20
r = json.load(open(REL))[0]
assert r['tag_name'] == 'v1.5.1', r['tag_name']
assets = {a['name']: a for a in r['assets']}
want = {n: assets[n] for n in (NAME, NAME + '.sha256', NAME + '.asc')}
assert want[NAME]['digest'] == 'sha256:6779c45dbc6041205cc4e52bc2cd9d40746a5a4366a309899bf6533fccebe2b7'
assert sum(a['size'] for a in want.values()) <= CAP
os.makedirs(OUT, mode=0o700)            # must be NEW
rec = {'release': {'tag': r['tag_name'], 'id': r['id'], 'url': r['html_url'], 'metadataSha256': hashlib.sha256(open(REL, 'rb').read()).hexdigest()}, 'assets': {}}
for n, a in want.items():
    url = a['browser_download_url']
    assert url == f'https://github.com/base/base/releases/download/v1.5.1/{n}', url
    h, size, path = hashlib.sha256(), 0, os.path.join(OUT, n)
    req = urllib.request.Request(url, headers={'User-Agent': 'fresh-witness-audit'})
    with urllib.request.urlopen(req, timeout=60) as resp, open(path, 'xb') as f:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            size += len(chunk)
            if size > a['size']:
                sys.exit(f'{n}: more than the recorded {a["size"]} bytes: refused')
            h.update(chunk); f.write(chunk)
    got = 'sha256:' + h.hexdigest()
    if size != a['size'] or got != a['digest']:
        os.remove(path)
        sys.exit(f'{n}: size {size} / digest {got} differ from the recorded {a["size"]} / {a["digest"]}: refused')
    rec['assets'][n] = {'url': url, 'size': size, 'sha256': h.hexdigest()}
side = open(os.path.join(OUT, NAME + '.sha256')).read().split()
rec['sidecarSha256Matches'] = side[0] == rec['assets'][NAME]['sha256']
assert rec['sidecarSha256Matches'], side
with tarfile.open(os.path.join(OUT, NAME), 'r:gz') as t:
    members = t.getmembers()
    rec['members'] = [{'name': m.name, 'type': 'file' if m.isreg() else 'dir' if m.isdir() else 'other', 'size': m.size, 'mode': oct(m.mode)} for m in members]
    picks = [m for m in members if m.isreg() and os.path.basename(m.name) == 'base']
    if len(picks) != 1:
        sys.exit(f'expected exactly one regular member named base, found {len(picks)}')
    m = picks[0]
    if m.name.startswith('/') or '..' in m.name.split('/') or m.size > MEMBER_MAX:
        sys.exit(f'unsafe member {m.name} ({m.size} bytes)')
    src = t.extractfile(m)
    dst = os.path.join(OUT, 'base')
    h = hashlib.sha256()
    with open(dst, 'xb') as f:
        while True:
            b = src.read(1 << 20)
            if not b:
                break
            h.update(b); f.write(b)
    os.chmod(dst, 0o755)
    rec['binary'] = {'member': m.name, 'size': m.size, 'sha256': h.hexdigest(), 'path': dst}
json.dump(rec, open(os.path.join(OUT, 'staged.json'), 'x'), indent=1)
print(json.dumps(rec, indent=1))

"""POST-BUILD exact-delta checks for the boot-price release (read-only). build-price.sh runs it after the two builds.
   python3 verify.py <stage> <old 9f manifest.json> <new manifest.json> <new initramfs.cpio.gz> <H repo> <commit> <image files JSON>
Against the root-built 08d1f838 image (9f6d37bd): the manifest differs only in controlOverlay.commit, the changed file records
(exactly the approved image files; no record added or removed; builder, base, supervisorClosure packages and duplicates
unchanged) and the initramfs record. Image entries differ from 08d1 by exactly those files + opt/metal/manifest.json, and from
production deabf8f90 by those + opt/metal/gsup.mjs (the a6b1378c vault restore) + manifest; every OTHER entry, including every
crypto, storage, lease and verifier module, is byte-identical. Every changed file and gsup.mjs in the image = the commit's bytes."""
import gzip, json, subprocess, sys

def manifest_problems(ma, mb, commit, image_files):
    out = []
    top = {k for k in set(ma) | set(mb) if ma.get(k) != mb.get(k)}
    if top != {'controlOverlay', 'initramfs'}: out.append(f'manifest top-level delta {sorted(top)}')
    ca, cb = ma.get('controlOverlay', {}), mb.get('controlOverlay', {})
    co = {k for k in set(ca) | set(cb) if ca.get(k) != cb.get(k)}
    if co != {'commit', 'files'}: out.append(f'controlOverlay delta {sorted(co)}')
    if cb.get('commit') != commit: out.append('controlOverlay.commit is not the approved commit')
    fa, fb = {f['path']: f for f in ca.get('files', [])}, {f['path']: f for f in cb.get('files', [])}
    if set(fa) != set(fb): out.append(f'file records added/removed: +{sorted(set(fb) - set(fa))} -{sorted(set(fa) - set(fb))}')
    changed = sorted(p for p in fb if p in fa and fa[p] != fb[p])
    if changed != sorted(image_files): out.append(f'changed records {changed} are not exactly {sorted(image_files)}')
    return out

def entries_problems(vs_9f, vs_prod, image_files):
    out = []
    want = sorted([p[1:] for p in image_files] + ['opt/metal/manifest.json'])
    if vs_9f != want: out.append(f'entries vs 08d1 {vs_9f} are not {want}')
    wp = sorted(set(want) | {'opt/metal/gsup.mjs'})
    if vs_prod != wp: out.append(f'entries vs production {vs_prod} are not {wp}')
    return out

def image_bytes(img, names):
    got = {}
    with gzip.open(img, 'rb') as f:
        buf = bytearray()
        def read(n):
            while len(buf) < n:
                c = f.read(65536)
                if not c: raise EOFError
                buf.extend(c)
            d = bytes(buf[:n]); del buf[:n]; return d
        while True:
            h = read(110); fld = [int(h[6+8*i:14+8*i], 16) for i in range(13)]
            name = read(fld[11])[:-1].decode(); read((-(110+fld[11])) % 4)
            data = read(fld[6]); read((-fld[6]) % 4)
            if name in names: got[name] = data
            if name == 'TRAILER!!!': break
    return got

if __name__ == '__main__':
    s, ma, mb, img, repo, commit, files = sys.argv[1], json.load(open(sys.argv[2])), json.load(open(sys.argv[3])), sys.argv[4], sys.argv[5], sys.argv[6], json.loads(sys.argv[7])
    last = lambda n: json.loads(open(f'{s}/{n}').read().splitlines()[-1])['differing']
    p = manifest_problems(ma, mb, commit, files) + entries_problems(last('entries-vs-9f.jsonl'), last('entries-vs-production.jsonl'), files)
    src = {f['path'][1:]: f['source'] for f in mb['controlOverlay']['files'] if f['path'] in set(files) | {'/opt/metal/gsup.mjs'}}
    got = image_bytes(img, set(src))
    for k, v in src.items():
        if got.get(k) != subprocess.check_output(['git', '-C', repo, 'show', f'{commit}:{v}']): p.append(f'image {k} is not the commit\'s {v}')
    if p: print('VERIFY-FAILED: ' + '; '.join(p)); sys.exit(1)
    print('MANIFEST-DELTA-EXACT', files); print('ENTRY-DELTA-EXACT vs 08d1', last('entries-vs-9f.jsonl'), 'vs production', last('entries-vs-production.jsonl'))
    print('IMAGE-FILES-ARE-SOURCE', sorted(src))

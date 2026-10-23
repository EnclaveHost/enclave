"""Bounded, read-only streaming inventory of a gzip'd newc initramfs (the production recipient image is never modified).

  python3 -I stream-initramfs.py <initramfs.cpio.gz> <outdir>

Reads the archive once as a stream (64 KiB chunks, no member held in memory beyond 64 KiB, no full decompression to disk).
- For every member under app/, opt/metal/, init, etc/ and usr/local/bin/guestd* (the public baked code and init), it records
  path, mode, size and sha256, and any name mentioning custody or guestd.
- It writes out ONLY the public, non-secret baked env file opt/metal/flavor-env.json (as KEY NAMES plus the values of
  custody/vault/chain/contract-address keys) and opt/metal/manifest.json if present. Nothing else is extracted.
- For the rest (the wasm chroot under opt/roots etc.) it counts members and bytes only.
"""
import gzip, hashlib, json, os, re, sys

src, outdir = sys.argv[1], sys.argv[2]
os.makedirs(outdir, exist_ok=True)
HASH = re.compile(r'^(app/|opt/metal/|init$|etc/|usr/local/bin/)')
WANT = {'opt/metal/flavor-env.json', 'opt/metal/manifest.json'}
f = gzip.open(src, 'rb')
buf = b''
def read(n):
    global buf
    while len(buf) < n:
        c = f.read(65536)
        if not c: raise EOFError('truncated archive')
        buf += c
    out, buf = buf[:n], buf[n:]
    return out
def skip(n):
    global buf
    while n > 0:
        if not buf:
            buf = f.read(65536)
            if not buf: raise EOFError('truncated archive')
        k = min(n, len(buf)); buf = buf[k:]; n -= k
members, other, otherBytes, named, wanted = [], 0, 0, [], {}
while True:
    h = read(110)
    if h[:6] not in (b'070701', b'070702'): raise ValueError(f'not newc at member {len(members) + other}: {h[:6]!r}')
    fld = [int(h[6 + 8 * i: 14 + 8 * i], 16) for i in range(13)]
    mode, size, namesize = fld[1], fld[6], fld[11]
    name = read(namesize)[:-1].decode('utf-8', 'replace')
    pad = (4 - (110 + namesize) % 4) % 4; skip(pad)
    if name == 'TRAILER!!!': break
    n = name[2:] if name.startswith('./') else name.lstrip('/')
    dpad = (4 - size % 4) % 4
    if 'custody' in n.lower() or 'guestd' in n.lower(): named.append(n)
    if HASH.match(n) and (mode & 0o170000) in (0o100000, 0o120000):
        hsh, left, keep = hashlib.sha256(), size, n in WANT
        chunks = []
        while left > 0:
            k = min(65536, left); d = read(k); hsh.update(d); left -= k
            if keep: chunks.append(d)
        members.append({'path': '/' + n, 'mode': oct(mode), 'bytes': size, 'sha256': hsh.hexdigest()})
        if keep: wanted[n] = b''.join(chunks)
    else:
        skip(size); other += 1; otherBytes += size
    skip(dpad)
inv = {'source': src, 'hashedMembers': len(members), 'otherMembers': other, 'otherBytes': otherBytes,
       'namesMentioningCustodyOrGuestd': sorted(set(named))[:200], 'members': members}
fe = wanted.get('opt/metal/flavor-env.json')
if fe is not None:
    env = json.loads(fe)
    KEEP = re.compile(r'(CUSTODY|VAULT|CHAIN_ID|REGISTRY_ADDRESS|LEDGER|ADDRESS_BOOK|HOST_OWNERSHIP)', re.I)
    SECRETISH = re.compile(r'(SECRET|TOKEN|PASSWORD|PRIVATE|KEY$|HMAC|MNEMONIC|SEED)', re.I)
    inv['flavorEnv'] = {'sha256': hashlib.sha256(fe).hexdigest(), 'keys': sorted(env),
                        'publicValues': {k: v for k, v in env.items() if KEEP.search(k) and not SECRETISH.search(k)},
                        'secretishKeysPresent': sorted(k for k in env if SECRETISH.search(k))}
if 'opt/metal/manifest.json' in wanted:
    inv['inImageManifestSha256'] = hashlib.sha256(wanted['opt/metal/manifest.json']).hexdigest()
json.dump(inv, open(os.path.join(outdir, 'initramfs-inventory.json'), 'w'), indent=1)
print(json.dumps({k: v for k, v in inv.items() if k != 'members'}, indent=1))

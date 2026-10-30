#!/usr/bin/env python3
"""b3bundle.py (offline-b3sum-bundle-stage/r1; PREPARED, never run by Claude). Python >= 3.8 stdlib + curl/gpgv/dpkg-deb. Unblocks Q1
on a network-restricted qualification VM: the package is fetched on the HOST, verified there and again OFFLINE in the guest.

  fetch    HOST (Arch; no Ubuntu keyring or b3sum installed there). Inputs are ROOT PINS only: the guest's Ubuntu archive keyring
           (extracted read-only by root's pinned OS inspector; --keyring + mandatory --keyring-sha256), the allowed primary signing-key
           fingerprints (--allowed-primary-fpr, root input), and an origin/suite/component from the fixed Ubuntu allowlists below.
           curl (https only, no redirects, size caps) -> InRelease; gpgv --status-fd with ONLY that keyring -> VALIDSIG/GOODSIG
           required, any BADSIG/ERRSIG/NO_PUBKEY/EXP*/REVKEYSIG refuses; only the gpgv-OUTPUT signed text is parsed (Release).
           Release SHA256 entry for <component>/binary-amd64/Packages.xz -> download (cap) -> size+sha256 checked BEFORE
           decompression -> bounded xz decompression (cap) -> the decompressed sha256 must equal Release's .../Packages entry if listed.
           Exactly ONE stanza Package=b3sum, Version=1.2.0-1, Architecture=amd64; Filename strictly under pool/<component>/
           (no traversal) -> .deb download (cap) -> size+sha256 = stanza. Writes everything into a NEW private 0700 dir with
           receipt.json + SHA256SUMS. The .deb is NEVER extracted or executed on the host; nothing is installed; no apt/global change.
  qualify  GUEST (noble), root, OFFLINE. Re-verifies the whole chain with the guest's OWN keyring (sha256 pin, which must equal the
           receipt's), extracts ONLY ./usr/bin/b3sum from `dpkg-deb --fsys-tarfile` (read as a stream; no other member is written),
           runs `--version` (must start "b3sum 1.2.0") and the empty-input KAT, records the proposed GSI_B3SUM_SHA256.
Scope (honest): empty-input KAT + version only here; the native qualification remains Q4 (all 4 state outputs incl. mdbx.dat equal the
manifest BLAKE3). No official test vectors are added (no source tarball is fetched).
Exit: 0 ok | 2 bad input/pin | 6 network/HTTP failure | 7 signature/chain refused | 8 metadata refused | 9 extraction/KAT refused.
"""
import argparse, hashlib, io, json, lzma, os, re, stat, subprocess, sys, tarfile, time

PACKAGE, VERSION, ARCH = 'b3sum', '1.2.0-1', 'amd64'
ALLOWED_ORIGINS = ('https://archive.ubuntu.com/ubuntu', 'https://security.ubuntu.com/ubuntu')
ALLOWED_SUITES = ('noble', 'noble-updates', 'noble-security')
ALLOWED_COMPONENTS = ('main', 'universe')
BLAKE3_EMPTY = 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262'
BAD_STATUS = ('BADSIG', 'ERRSIG', 'NO_PUBKEY', 'EXPSIG', 'EXPKEYSIG', 'REVKEYSIG', 'KEYEXPIRED', 'KEYREVOKED', 'NODATA', 'FAILURE')
CAP_INRELEASE, CAP_PKGS_XZ, CAP_PKGS, CAP_DEB, CAP_TOOL = 4 << 20, 64 << 20, 512 << 20, 32 << 20, 32 << 20
ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}


class Refuse(Exception):
    def __init__(self, code, msg, **detail):
        super().__init__(msg); self.code, self.detail = code, detail


def sha256b(b):
    return hashlib.sha256(b).hexdigest()


def read_regular(path, cap):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > cap:
            raise Refuse(2, f'{path} is not a regular file within {cap} bytes')
        with os.fdopen(os.dup(fd), 'rb') as f:
            return f.read(cap + 1)
    finally:
        os.close(fd)


# ------------------------------------------------------------------ pure verification (unit-tested; no I/O) ------------------------
def parse_gpgv_status(status, allowed_fprs):
    """--status-fd lines -> list of verified primary fingerprints; refuses on any bad status or an unexpected key"""
    lines = [l.split()[1:] for l in status.splitlines() if l.startswith('[GNUPG:] ')]
    kinds = [l[0] for l in lines if l]
    bad = sorted(set(k for k in kinds if k in BAD_STATUS))
    if bad:
        raise Refuse(7, f'gpgv reported {bad}: signature chain refused (unknown key, bad or expired signature)')
    valid = [l for l in lines if l and l[0] == 'VALIDSIG']
    if not valid or 'GOODSIG' not in kinds or kinds.count('GOODSIG') != len(valid):
        raise Refuse(7, 'no complete GOODSIG+VALIDSIG pair from gpgv')
    prim = []
    for v in valid:
        if len(v) < 11 or not re.fullmatch(r'[0-9A-F]{40}', v[10]):
            raise Refuse(7, 'malformed VALIDSIG line')
        prim.append(v[10])
    allowed = {f.upper() for f in allowed_fprs}
    if not allowed or any(p not in allowed for p in prim):
        raise Refuse(7, 'signature by a primary key outside the root-pinned fingerprints', got=prim)
    return prim


def parse_release(text, suite, component):
    """signed Release text -> {'xz': (sha, size), 'plain': (sha, size)|None, 'date': str}; strict"""
    fields, sha_lines, in_sha = {}, [], False
    for line in text.splitlines():
        if re.match(r'^[A-Za-z0-9-]+:', line):
            k, v = line.split(':', 1); in_sha = (k == 'SHA256'); fields[k] = v.strip(); continue
        if in_sha and line.startswith(' '):
            sha_lines.append(line.split())
    if fields.get('Suite') != suite:
        raise Refuse(8, 'Release Suite does not match the requested suite', suite=fields.get('Suite'))
    if fields.get('Codename') != 'noble':
        raise Refuse(8, 'Release Codename is not noble', codename=fields.get('Codename'))
    want = {f'{component}/binary-{ARCH}/Packages.xz': 'xz', f'{component}/binary-{ARCH}/Packages': 'plain'}
    got = {}
    for parts in sha_lines:
        if len(parts) != 3 or not re.fullmatch(r'[0-9a-f]{64}', parts[0]) or not parts[1].isdigit():
            raise Refuse(8, 'malformed SHA256 line in Release')
        if parts[2] in want:
            if want[parts[2]] in got:
                raise Refuse(8, f'duplicate Release entry {parts[2]}')
            got[want[parts[2]]] = (parts[0], int(parts[1]))
    if 'xz' not in got:
        raise Refuse(8, f'Release lists no SHA256 for {component}/binary-{ARCH}/Packages.xz')
    return {'xz': got['xz'], 'plain': got.get('plain'), 'date': fields.get('Date'), 'suite': fields.get('Suite'),
            'codename': fields.get('Codename')}


def check_blob(blob, sha, size, what):
    if len(blob) != size or sha256b(blob) != sha:
        raise Refuse(8, f'{what} size/sha256 differs from the signed metadata', got=[len(blob), sha256b(blob)], want=[size, sha])


def bounded_unxz(blob, cap):
    d = lzma.LZMADecompressor(format=lzma.FORMAT_XZ, memlimit=256 << 20)
    try:
        out = d.decompress(blob, max_length=cap + 1)
    except lzma.LZMAError as e:
        raise Refuse(8, f'Packages.xz does not decompress: {e}')
    if len(out) > cap or not d.eof or d.unused_data:
        raise Refuse(8, f'Packages decompressed beyond {cap} bytes, truncated or with trailing data')
    return out


def select_stanza(packages_text, component):
    hits = []
    for block in re.split(r'\n\s*\n', packages_text):
        f = {}
        for line in block.splitlines():
            m = re.match(r'^([A-Za-z0-9-]+):\s?(.*)$', line)
            if m:
                f[m.group(1)] = m.group(2)
        if f.get('Package') == PACKAGE and f.get('Version') == VERSION and f.get('Architecture') == ARCH:
            hits.append(f)
    if len(hits) != 1:
        raise Refuse(8, f'expected exactly one {PACKAGE} {VERSION} {ARCH} stanza, found {len(hits)} (version unavailable or ambiguous)')
    f = hits[0]
    fn = f.get('Filename', '')
    if not re.fullmatch(rf'pool/{component}/[a-z0-9]+/[a-z0-9][a-z0-9+.-]*/{PACKAGE}_{re.escape(VERSION)}_{ARCH}\.deb', fn) \
            or '..' in fn.split('/') or '//' in fn:
        raise Refuse(8, 'stanza Filename is not a plain pool path for this package', filename=fn)
    if not re.fullmatch(r'[0-9a-f]{64}', f.get('SHA256', '')) or not f.get('Size', '').isdigit() or not 0 < int(f['Size']) <= CAP_DEB:
        raise Refuse(8, 'stanza SHA256/Size malformed or beyond the cap')
    return {k: f[k] for k in ('Package', 'Version', 'Architecture', 'Filename', 'Size', 'SHA256') if k in f} | \
        {k: f[k] for k in ('Source', 'Depends') if k in f}


def extract_only_tool(fsys_tar_bytes):
    """from dpkg-deb --fsys-tarfile output, return the bytes of ./usr/bin/b3sum; refuses links, duplicates, traversal-shaped names"""
    hits = []
    with tarfile.open(fileobj=io.BytesIO(fsys_tar_bytes), mode='r:') as tf:
        for m in tf.getmembers():
            n = m.name
            if n.startswith('/') or '..' in n.split('/'):
                raise Refuse(9, f'package payload has an absolute or traversal member: {n}')
            if n in ('./usr/bin/b3sum', 'usr/bin/b3sum'):
                hits.append(m)
        if len(hits) != 1 or not hits[0].isreg() or not 0 < hits[0].size <= CAP_TOOL:
            raise Refuse(9, 'usr/bin/b3sum is not exactly one regular member within the cap')
        return tf.extractfile(hits[0]).read()


def check_tool_outputs(version_out, kat_out):
    if not version_out.strip().startswith('b3sum 1.2.0'):
        raise Refuse(9, 'tool --version is not b3sum 1.2.0', got=version_out.strip()[:120])
    if kat_out.strip() != BLAKE3_EMPTY:
        raise Refuse(9, 'tool fails the empty-input BLAKE3 known answer', got=kat_out.strip()[:80])


# ------------------------------------------------------------------ shared chain ------------------------------------------------------
def verify_chain(a, keyring, inrelease, packages_xz, deb, workdir):
    """signature -> Release -> Packages.xz -> Packages -> stanza -> .deb, with keyring `keyring`; returns the evidence dict"""
    signed = os.path.join(workdir, 'Release.signed')
    if os.path.lexists(signed):
        raise Refuse(2, f'{signed} exists')
    r = subprocess.run([a.gpgv, '--status-fd', '1', '--keyring', keyring, '--output', signed, inrelease],
                       capture_output=True, text=True, timeout=120, env=ENV)
    if r.returncode != 0:
        parse_gpgv_status(r.stdout, a.allowed_primary_fpr)                    # raises the precise reason when it can
        raise Refuse(7, f'gpgv exited {r.returncode}', stderr=r.stderr[-500:])
    fprs = parse_gpgv_status(r.stdout, a.allowed_primary_fpr)
    rel_bytes = read_regular(signed, CAP_INRELEASE)
    rel = parse_release(rel_bytes.decode('utf-8', 'strict'), a.suite, a.component)
    xz = read_regular(packages_xz, CAP_PKGS_XZ)
    check_blob(xz, rel['xz'][0], rel['xz'][1], 'Packages.xz')                 # BEFORE decompression
    pk = bounded_unxz(xz, CAP_PKGS)
    if rel['plain']:
        check_blob(pk, rel['plain'][0], rel['plain'][1], 'Packages (decompressed)')
    st = select_stanza(pk.decode('utf-8', 'strict'), a.component)
    debb = read_regular(deb, CAP_DEB)
    check_blob(debb, st['SHA256'], int(st['Size']), '.deb')
    return {'gpgvStatus': [l for l in r.stdout.splitlines() if l.startswith('[GNUPG:] ')], 'primaryFingerprints': fprs,
            'releaseSignedSha256': sha256b(rel_bytes), 'release': rel, 'packagesXz': {'sha256': rel['xz'][0], 'size': rel['xz'][1]},
            'packagesSha256': sha256b(pk), 'packagesSize': len(pk), 'stanza': st, 'debSha256': sha256b(debb), 'debSize': len(debb)}


def common_checks(a):
    if a.origin not in ALLOWED_ORIGINS or a.suite not in ALLOWED_SUITES or a.component not in ALLOWED_COMPONENTS:
        raise Refuse(2, 'origin/suite/component outside the fixed Ubuntu allowlists')
    if not os.path.isabs(a.keyring) or not re.fullmatch(r'[0-9a-f]{64}', a.keyring_sha256):
        raise Refuse(2, '--keyring must be absolute and --keyring-sha256 a pin')
    if sha256b(read_regular(a.keyring, 4 << 20)) != a.keyring_sha256:
        raise Refuse(2, 'keyring sha256 differs from the root pin')
    if not a.allowed_primary_fpr or any(not re.fullmatch(r'[0-9A-Fa-f]{40}', f) for f in a.allowed_primary_fpr):
        raise Refuse(2, '--allowed-primary-fpr (40-hex, root input) is required')


def new_private_dir(p):
    if not os.path.isabs(p) or os.path.lexists(p):
        raise Refuse(2, f'{p} must be a NEW absolute path')
    os.mkdir(p, 0o700); os.chmod(p, 0o700)


def curl_get(a, url, out, cap):
    cmd = [a.curl, '-q', '-sS', '--fail', '--proto', '=https', '--tlsv1.2', '--max-redirs', '0', '--max-filesize', str(cap),
           '--connect-timeout', '30', '--max-time', str(a.http_timeout), '-o', out, url]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=a.http_timeout + 30, env=ENV)
    if r.returncode != 0 or not os.path.isfile(out) or os.path.getsize(out) > cap:
        raise Refuse(6, f'download failed or beyond cap: {url}', curl_rc=r.returncode, stderr=r.stderr[-300:])


def cmd_fetch(a):
    common_checks(a)
    new_private_dir(a.out)
    base = f'{a.origin}/dists/{a.suite}'
    files = {'InRelease': (f'{base}/InRelease', CAP_INRELEASE),
             'Packages.xz': (f'{base}/{a.component}/binary-{ARCH}/Packages.xz', CAP_PKGS_XZ)}
    for name, (url, cap) in files.items():
        curl_get(a, url, os.path.join(a.out, name), cap)
    # the stanza (from verified metadata) names the pool path; verify the chain once to get it, then fetch the .deb, then verify fully
    pre = os.path.join(a.out, 'precheck'); os.mkdir(pre, 0o700)
    signed = os.path.join(pre, 'Release.signed')
    r = subprocess.run([a.gpgv, '--status-fd', '1', '--keyring', a.keyring, '--output', signed, os.path.join(a.out, 'InRelease')],
                       capture_output=True, text=True, timeout=120, env=ENV)
    parse_gpgv_status(r.stdout, a.allowed_primary_fpr)
    if r.returncode != 0:
        raise Refuse(7, f'gpgv exited {r.returncode}')
    rel = parse_release(read_regular(signed, CAP_INRELEASE).decode('utf-8', 'strict'), a.suite, a.component)
    xz = read_regular(os.path.join(a.out, 'Packages.xz'), CAP_PKGS_XZ)
    check_blob(xz, rel['xz'][0], rel['xz'][1], 'Packages.xz')
    st = select_stanza(bounded_unxz(xz, CAP_PKGS).decode('utf-8', 'strict'), a.component)
    deb_name = os.path.basename(st['Filename'])
    curl_get(a, f'{a.origin}/{st["Filename"]}', os.path.join(a.out, deb_name), CAP_DEB)
    ev = verify_chain(a, a.keyring, os.path.join(a.out, 'InRelease'), os.path.join(a.out, 'Packages.xz'),
                      os.path.join(a.out, deb_name), a.out)
    for n in os.listdir(pre):
        os.unlink(os.path.join(pre, n))
    os.rmdir(pre)
    cv = subprocess.run([a.curl, '--version'], capture_output=True, text=True, env=ENV).stdout.splitlines()[:1]
    receipt = {'format': 'enclave-offline-b3sum-bundle/r1', 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
               'origin': a.origin, 'suite': a.suite, 'component': a.component, 'arch': ARCH, 'package': PACKAGE, 'version': VERSION,
               'keyringSha256': a.keyring_sha256, 'allowedPrimaryFingerprints': sorted(f.upper() for f in a.allowed_primary_fpr),
               'curl': cv, 'urls': {k: v[0] for k, v in files.items()} | {'deb': f'{a.origin}/{st["Filename"]}'},
               'files': {n: sha256b(read_regular(os.path.join(a.out, n), CAP_PKGS_XZ)) for n in ('InRelease', 'Release.signed',
                                                                                                  'Packages.xz', deb_name)},
               'evidence': ev, 'note': 'host-verified transport chain; the .deb was never extracted or executed on the host'}
    with open(os.path.join(a.out, 'receipt.json'), 'x') as f:
        json.dump(receipt, f, indent=1, sort_keys=True); f.write('\n')
    names = sorted(os.listdir(a.out))
    with open(os.path.join(a.out, 'SHA256SUMS'), 'x') as f:
        for n in names:
            f.write(f'{sha256b(read_regular(os.path.join(a.out, n), CAP_PKGS_XZ))}  {n}\n')
    print(json.dumps({'event': 'bundle-ready', 'out': a.out, 'receiptSha256': sha256b(read_regular(os.path.join(a.out, 'receipt.json'), 1 << 20)),
                      'debSha256': ev['debSha256'], 'primaryFingerprints': ev['primaryFingerprints']}))
    return 0


def cmd_qualify(a):
    common_checks(a)
    rec_b = read_regular(os.path.join(a.bundle, 'receipt.json'), 1 << 20)
    if sha256b(rec_b) != a.receipt_sha256:
        raise Refuse(2, 'receipt.json is not the root-pinned receipt')
    rec = json.loads(rec_b)
    if (rec.get('format'), rec.get('origin'), rec.get('suite'), rec.get('component'), rec.get('keyringSha256')) != \
            ('enclave-offline-b3sum-bundle/r1', a.origin, a.suite, a.component, a.keyring_sha256):
        raise Refuse(2, 'receipt origin/suite/component/keyring differ from this qualification (guest keyring must equal the host one)')
    deb_name = os.path.basename(rec['evidence']['stanza']['Filename'])
    if deb_name != f'{PACKAGE}_{VERSION}_{ARCH}.deb':
        raise Refuse(8, 'receipt names another package file', deb=deb_name)
    for n, h in rec['files'].items():
        if n != 'Release.signed' and sha256b(read_regular(os.path.join(a.bundle, n), CAP_PKGS_XZ)) != h:
            raise Refuse(8, f'bundle file {n} differs from the receipt')
    new_private_dir(a.scratch)
    ev = verify_chain(a, a.keyring, os.path.join(a.bundle, 'InRelease'), os.path.join(a.bundle, 'Packages.xz'),
                      os.path.join(a.bundle, deb_name), a.scratch)               # with the GUEST's own keyring
    if ev['stanza'] != rec['evidence']['stanza'] or ev['debSha256'] != rec['evidence']['debSha256'] or \
            ev['releaseSignedSha256'] != rec['evidence']['releaseSignedSha256'] or ev['packagesSha256'] != rec['evidence']['packagesSha256']:
        raise Refuse(8, 'guest re-verification differs from the host receipt')
    r = subprocess.run([a.dpkg_deb, '--fsys-tarfile', os.path.join(a.bundle, deb_name)], capture_output=True, timeout=120, env=ENV)
    if r.returncode != 0 or len(r.stdout) > 4 * CAP_DEB:
        raise Refuse(9, 'dpkg-deb --fsys-tarfile failed or oversized')
    tool = extract_only_tool(r.stdout)
    tp = os.path.join(a.scratch, 'b3sum')
    fd = os.open(tp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o500)
    with os.fdopen(fd, 'wb') as f:
        f.write(tool)
    empty = os.path.join(a.scratch, 'kat-empty'); open(empty, 'xb').close()
    v = subprocess.run([tp, '--version'], capture_output=True, text=True, timeout=30, env=ENV)
    k = subprocess.run([tp, '--no-names', empty], capture_output=True, text=True, timeout=30, env=ENV)
    check_tool_outputs(v.stdout if v.returncode == 0 else '', k.stdout if k.returncode == 0 else '')
    res = {'format': 'enclave-offline-b3sum-qualification/r1', 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
           'receiptSha256': a.receipt_sha256, 'evidence': ev, 'tool': {'path': tp, 'sha256': sha256b(tool), 'version': v.stdout.strip()},
           'kat': {'input': 'empty', 'expect': BLAKE3_EMPTY, 'got': k.stdout.strip()},
           'proposed': {'GSI_B3SUM_SHA256': sha256b(tool)},
           'scope': 'version + empty-input KAT only; the native qualification is Q4 (all 4 state outputs incl. mdbx.dat = manifest BLAKE3)'}
    with open(os.path.join(a.scratch, 'qualification.json'), 'x') as f:
        json.dump(res, f, indent=1, sort_keys=True); f.write('\n')
    print(json.dumps({'event': 'b3sum-qualified-for-q1', 'proposed_GSI_B3SUM_SHA256': sha256b(tool), 'record': os.path.join(a.scratch, 'qualification.json')}))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    sub = ap.add_subparsers(dest='cmd', required=True)
    for name in ('fetch', 'qualify'):
        p = sub.add_parser(name)
        p.add_argument('--keyring', required=True); p.add_argument('--keyring-sha256', required=True)
        p.add_argument('--allowed-primary-fpr', action='append', default=[], required=True)
        p.add_argument('--origin', required=True); p.add_argument('--suite', required=True); p.add_argument('--component', required=True)
        p.add_argument('--gpgv', default='/usr/bin/gpgv')
        if name == 'fetch':
            p.add_argument('--out', required=True); p.add_argument('--curl', default='/usr/bin/curl')
            p.add_argument('--http-timeout', type=int, default=600)
        else:
            p.add_argument('--bundle', required=True); p.add_argument('--receipt-sha256', required=True)
            p.add_argument('--scratch', required=True); p.add_argument('--dpkg-deb', default='/usr/bin/dpkg-deb')
    a = ap.parse_args(argv)
    try:
        return {'fetch': cmd_fetch, 'qualify': cmd_qualify}[a.cmd](a)
    except Refuse as e:
        print(json.dumps({'event': 'refused', 'code': e.code, 'reason': str(e), 'detail': e.detail})); return e.code
    except (OSError, ValueError, UnicodeDecodeError, KeyError, subprocess.TimeoutExpired) as e:
        print(json.dumps({'event': 'refused', 'code': 2, 'reason': f'{type(e).__name__}: {e}'})); return 2


if __name__ == '__main__':
    sys.exit(main())

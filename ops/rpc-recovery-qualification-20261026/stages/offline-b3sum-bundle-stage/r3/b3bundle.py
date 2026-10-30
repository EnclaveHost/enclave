#!/usr/bin/env python3
"""b3bundle.py (offline-b3sum-bundle-stage/r3; PREPARED, never run by Claude). Python >= 3.9 stdlib + curl/gpgv/dpkg-deb.
Unblocks Q1 on a network-restricted qualification VM: the package is fetched on the HOST, verified there and again OFFLINE in the guest.

r3 vs r2 (root 1516/1517): the official signed noble Packages.xz is TWO concatenated xz streams (data + a 32-byte empty stream), which
r2 refused as trailing data. bounded_unxz now decodes every concatenated stream (each with its own 256 MiB-memlimit decoder) plus valid
stream padding (zero bytes, multiple of 4), with the TOTAL output <= cap and at most MAX_XZ_STREAMS streams; truncated/garbage/corrupt
streams, odd padding, too many streams or an over-budget total refuse (rc 8). All SHA/size checks are unchanged (compressed digest
before decompression; the concatenated output must equal the signed `Packages` entry when listed). Receipt format bumped to r3.

r2 vs r1 (logs/claude-b3bundle-r1-review.md): S1 the package version is a REQUIRED root pin (--package-version), recorded in the receipt,
compared in qualify, and the tool --version check is derived from it; S2 malformed tar/receipt inputs give typed refusals (never a
traceback); S3 qualify requires the receipt's allowed-fingerprint set AND verified primary fingerprints to equal this run's; S4 every
VALIDSIG must use SHA-256/384/512 (hash algo 8/9/10; SHA-1 and others refuse); B1 HTTPS stays the default -- plain HTTP only with an
explicit --transport http and only for the two exact origins of the pinned guest ubuntu.sources (e93b42f6...); trust never depends on
transport (pinned keyring + pinned fingerprints + signed Release + hash chain); B2 the Packages index stays bytes and only matching
stanzas are decoded (lower peak); fetch is run through the queue (README).

  fetch    HOST. curl (no redirects, size caps) -> InRelease; gpgv --status-fd with ONLY the pinned keyring -> complete GOODSIG+VALIDSIG
           pairs from pinned primary fingerprints with SHA-2 digests; any bad/unknown/expired status refuses; only gpgv's OUTPUT (the
           signed text) is parsed. Release SHA256 entry -> Packages.xz size+sha256 BEFORE decompression -> bounded xz -> exactly ONE
           stanza (b3sum, pinned version, amd64; strict pool path) -> .deb size+sha256 = stanza. NEW private 0700 dir with receipt.json +
           SHA256SUMS. The .deb is never extracted or executed on the host; nothing is installed; no apt/global change.
  qualify  GUEST (noble), root, OFFLINE: the receipt (pinned) and the guest's own keyring (pinned, = the receipt's) -> full chain re-verified
           and compared to the receipt (stanza, version, hashes, fingerprints, allowed set) -> ONLY ./usr/bin/b3sum from
           `dpkg-deb --fsys-tarfile` -> --version matches the pinned upstream version -> empty-input KAT -> proposed GSI_B3SUM_SHA256.
Scope: provenance + identity + version + empty-input KAT only. Native qualification remains Q4 (all 4 state outputs = manifest BLAKE3).
Exit: 0 ok | 2 bad input/pin | 6 network/HTTP failure | 7 signature/chain refused | 8 metadata refused | 9 extraction/KAT refused.
"""
import argparse, hashlib, io, json, lzma, os, re, stat, subprocess, sys, tarfile, time

PACKAGE, ARCH = 'b3sum', 'amd64'
HTTPS_ORIGINS = ('https://archive.ubuntu.com/ubuntu', 'https://security.ubuntu.com/ubuntu')
HTTP_ORIGINS = ('http://archive.ubuntu.com/ubuntu', 'http://security.ubuntu.com/ubuntu')   # exactly the pinned guest ubuntu.sources URIs
ALLOWED_SUITES = ('noble', 'noble-updates', 'noble-security')
ALLOWED_COMPONENTS = ('main', 'universe')
SHA2_HASH_ALGOS = {'8': 'SHA256', '9': 'SHA384', '10': 'SHA512'}
VERSION_RE = r'(?:[0-9]+:)?[0-9][A-Za-z0-9.+~]*(?:-[A-Za-z0-9.+~]+)?'      # Debian version (optional epoch, optional revision)
BLAKE3_EMPTY = 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262'
BAD_STATUS = ('BADSIG', 'ERRSIG', 'NO_PUBKEY', 'EXPSIG', 'EXPKEYSIG', 'REVKEYSIG', 'KEYEXPIRED', 'KEYREVOKED', 'NODATA', 'FAILURE')
CAP_INRELEASE, CAP_PKGS_XZ, CAP_PKGS, CAP_DEB, CAP_TOOL = 4 << 20, 64 << 20, 512 << 20, 32 << 20, 32 << 20
ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}
RECEIPT_FORMAT = 'enclave-offline-b3sum-bundle/r3'
XZ_MAGIC, XZ_MEMLIMIT, MAX_XZ_STREAMS = b'\xfd7zXZ\x00', 256 << 20, 8      # per-decoder memlimit; bounded stream count
ZERO_RUN = re.compile(rb'\x00*')


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
def check_version_pin(v):
    if not isinstance(v, str) or not re.fullmatch(VERSION_RE, v):
        raise Refuse(2, '--package-version must be an exact Debian version (root pin)', got=v)
    return v


def filename_version(v):
    """Debian pool file names drop the epoch"""
    return v.split(':', 1)[1] if ':' in v else v


def upstream_version(v):
    v = filename_version(v)
    return v.rsplit('-', 1)[0] if '-' in v else v


def parse_gpgv_status(status, allowed_fprs):
    """--status-fd lines -> verified primary fingerprints; refuses on any bad status, an unpinned key or a non-SHA-2 digest"""
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
        if v[8] not in SHA2_HASH_ALGOS:                                         # S4: VALIDSIG field 8 = hash algorithm
            raise Refuse(7, f'signature digest algorithm {v[8]} is not SHA-256/384/512', fpr=v[10])
        prim.append(v[10])
    allowed = {f.upper() for f in allowed_fprs}
    if not allowed or any(p not in allowed for p in prim):
        raise Refuse(7, 'signature by a primary key outside the root-pinned fingerprints', got=prim)
    return sorted(set(prim))


def parse_release(text, suite, component):
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
    return {'xz': list(got['xz']), 'plain': list(got['plain']) if 'plain' in got else None, 'date': fields.get('Date'),
            'suite': fields.get('Suite'), 'codename': fields.get('Codename')}


def check_blob(blob, sha, size, what):
    if len(blob) != size or sha256b(blob) != sha:
        raise Refuse(8, f'{what} size/sha256 differs from the signed metadata', got=[len(blob), sha256b(blob)], want=[size, sha])


def bounded_unxz(blob, cap):
    """r3: a .xz FILE is one or more concatenated xz streams, each optionally followed by stream padding (zero bytes, a multiple of
    4; xz file-format spec 2.2). Official noble Packages.xz = one data stream + one 32-byte empty stream (root 1517). Every stream is
    decoded to its end with its own decoder (memlimit XZ_MEMLIMIT); the TOTAL output is capped; at most MAX_XZ_STREAMS streams; anything
    else after a stream (truncation, garbage, odd padding, a corrupt stream) refuses. Nothing is ignored."""
    mv, n, pos, streams, total, parts = memoryview(blob), len(blob), 0, 0, 0, []
    if n == 0 or bytes(mv[:6]) != XZ_MAGIC:
        raise Refuse(8, 'Packages.xz does not start with an xz stream')
    while pos < n:
        if bytes(mv[pos:pos + 6]) != XZ_MAGIC:
            raise Refuse(8, 'Packages.xz has non-xz data after a stream', offset=pos)
        streams += 1
        if streams > MAX_XZ_STREAMS:
            raise Refuse(8, f'Packages.xz has more than {MAX_XZ_STREAMS} xz streams')
        d = lzma.LZMADecompressor(format=lzma.FORMAT_XZ, memlimit=XZ_MEMLIMIT)
        rest = mv[pos:]
        try:
            out = d.decompress(rest, max_length=cap - total + 1)
        except lzma.LZMAError as e:
            raise Refuse(8, f'Packages.xz stream {streams} does not decompress: {e}', offset=pos)
        total += len(out)
        if total > cap:
            raise Refuse(8, f'Packages decompressed beyond {cap} bytes (all streams)', streams=streams)
        if not d.eof:
            raise Refuse(8, f'Packages.xz stream {streams} is truncated', offset=pos)
        if out:
            parts.append(out)
        pos += len(rest) - len(d.unused_data); del rest, d, out
        pad = ZERO_RUN.match(blob, pos).end() - pos                              # stream padding
        if pad % 4:
            raise Refuse(8, 'Packages.xz stream padding is not a multiple of 4 zero bytes', offset=pos, padding=pad)
        pos += pad
    return parts[0] if len(parts) == 1 else b''.join(parts)                  # official layout: one non-empty part, no copy


def select_stanza(packages, component, version):
    """packages: the decompressed index as BYTES; only stanzas starting with `Package: b3sum` are decoded (B2)"""
    if isinstance(packages, str):
        packages = packages.encode()
    hits = []
    for m in re.finditer(rb'(?m)^Package: ' + re.escape(PACKAGE.encode()) + rb'\n', packages):
        start = packages.rfind(b'\n\n', 0, m.start())
        if (0 if start < 0 else start + 2) != m.start():
            raise Refuse(8, 'a b3sum stanza does not start with its Package field')
        end = packages.find(b'\n\n', m.start())
        block = packages[m.start(): end if end >= 0 else len(packages)]
        try:
            text = block.decode('utf-8', 'strict')
        except UnicodeDecodeError:
            raise Refuse(8, 'b3sum stanza is not valid UTF-8')
        f = {}
        for line in text.splitlines():
            mm = re.match(r'^([A-Za-z0-9-]+):\s?(.*)$', line)
            if mm:
                if mm.group(1) in f:
                    raise Refuse(8, f'duplicated field {mm.group(1)} in a b3sum stanza')
                f[mm.group(1)] = mm.group(2)
        if f.get('Package') == PACKAGE and f.get('Version') == version and f.get('Architecture') == ARCH:
            hits.append(f)
    if len(hits) != 1:
        raise Refuse(8, f'expected exactly one {PACKAGE} {version} {ARCH} stanza, found {len(hits)} (version unavailable or ambiguous)')
    f = hits[0]
    fn = f.get('Filename', '')
    if not re.fullmatch(rf'pool/{component}/[a-z0-9]+/[a-z0-9][a-z0-9+.-]*/{PACKAGE}_{re.escape(filename_version(version))}_{ARCH}\.deb', fn) \
            or '..' in fn.split('/') or '//' in fn:
        raise Refuse(8, 'stanza Filename is not a plain pool path for this package', filename=fn)
    if not re.fullmatch(r'[0-9a-f]{64}', f.get('SHA256', '')) or not re.fullmatch(r'[0-9]{1,9}', f.get('Size', '')) or not 0 < int(f['Size']) <= CAP_DEB:
        raise Refuse(8, 'stanza SHA256/Size malformed or beyond the cap')
    out = {k: f[k] for k in ('Package', 'Version', 'Architecture', 'Filename', 'Size', 'SHA256')}
    out.update({k: f[k] for k in ('Source', 'Depends') if k in f})
    return out


def extract_only_tool(fsys_tar_bytes):
    hits = []
    try:
        with tarfile.open(fileobj=io.BytesIO(fsys_tar_bytes), mode='r:') as tf:
            for m in tf.getmembers():
                n = m.name
                if n.startswith('/') or '..' in n.split('/'):
                    raise Refuse(9, f'package payload has an absolute or traversal member: {n}')
                if n in ('./usr/bin/b3sum', 'usr/bin/b3sum'):
                    hits.append(m)
            if len(hits) != 1 or not hits[0].isreg() or not 0 < hits[0].size <= CAP_TOOL:
                raise Refuse(9, 'usr/bin/b3sum is not exactly one regular member within the cap')
            data = tf.extractfile(hits[0]).read()
    except tarfile.TarError as e:                                               # S2: typed refusal, never a traceback
        raise Refuse(9, f'package payload is not a readable tar: {e}')
    if len(data) != hits[0].size:
        raise Refuse(9, 'tool member truncated')
    return data


def check_tool_outputs(version_out, kat_out, version):
    want = f'{PACKAGE} {upstream_version(version)}'
    first = version_out.strip().splitlines()[0] if version_out.strip() else ''
    if first != want and not first.startswith(want + ' '):                     # "b3sum 1.2.0" (not "1.2.01")
        raise Refuse(9, f'tool --version is not "{want}"', got=first[:120])
    if kat_out.strip() != BLAKE3_EMPTY:
        raise Refuse(9, 'tool fails the empty-input BLAKE3 known answer', got=kat_out.strip()[:80])


def validate_receipt(rec):
    """S2: a malformed receipt is a typed refusal"""
    try:
        ok = (isinstance(rec, dict) and rec.get('format') == RECEIPT_FORMAT and isinstance(rec.get('evidence'), dict)
              and isinstance(rec['evidence'].get('stanza'), dict) and isinstance(rec['evidence']['stanza'].get('Filename'), str)
              and isinstance(rec.get('files'), dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in rec['files'].items())
              and isinstance(rec.get('allowedPrimaryFingerprints'), list) and isinstance(rec['evidence'].get('primaryFingerprints'), list)
              and isinstance(rec.get('packageVersion'), str))
    except (AttributeError, TypeError):
        ok = False
    if not ok:
        raise Refuse(2, 'receipt.json is not a well-formed r3 receipt')


def compare_receipt(rec, a, ev):
    """S1/S3: the guest run must use the SAME trust inputs and see the SAME chain as the host receipt"""
    want = {'transport': a.transport, 'origin': a.origin, 'suite': a.suite, 'component': a.component, 'keyringSha256': a.keyring_sha256,
            'packageVersion': a.package_version, 'allowedPrimaryFingerprints': sorted({f.upper() for f in a.allowed_primary_fpr})}
    diff = sorted(k for k, v in want.items() if rec.get(k) != v)
    if diff:
        raise Refuse(2, 'receipt trust inputs differ from this qualification run', fields=diff)
    e = rec['evidence']
    for k in ('stanza', 'debSha256', 'releaseSignedSha256', 'packagesSha256', 'primaryFingerprints'):
        if e.get(k) != ev.get(k):
            raise Refuse(8, f'guest re-verification differs from the host receipt: {k}')


# ------------------------------------------------------------------ chain + commands ---------------------------------------------------
def gpgv_release(a, keyring, inrelease, signed):
    if os.path.lexists(signed):
        raise Refuse(2, f'{signed} exists')
    r = subprocess.run([a.gpgv, '--status-fd', '1', '--keyring', keyring, '--output', signed, inrelease],
                       capture_output=True, text=True, timeout=120, env=ENV)
    fprs = parse_gpgv_status(r.stdout, a.allowed_primary_fpr)
    if r.returncode != 0:
        raise Refuse(7, f'gpgv exited {r.returncode}', stderr=r.stderr[-500:])
    return r, fprs


def verify_chain(a, keyring, inrelease, packages_xz, deb, workdir):
    r, fprs = gpgv_release(a, keyring, inrelease, os.path.join(workdir, 'Release.signed'))
    rel_bytes = read_regular(os.path.join(workdir, 'Release.signed'), CAP_INRELEASE)
    rel = parse_release(rel_bytes.decode('utf-8', 'strict'), a.suite, a.component)
    xz = read_regular(packages_xz, CAP_PKGS_XZ)
    check_blob(xz, rel['xz'][0], rel['xz'][1], 'Packages.xz')                 # BEFORE decompression
    pk = bounded_unxz(xz, CAP_PKGS); del xz
    if rel['plain']:
        check_blob(pk, rel['plain'][0], rel['plain'][1], 'Packages (decompressed)')
    pk_sha, pk_len = sha256b(pk), len(pk)
    st = select_stanza(pk, a.component, a.package_version); del pk
    debb = read_regular(deb, CAP_DEB)
    check_blob(debb, st['SHA256'], int(st['Size']), '.deb')
    return {'gpgvStatus': [l for l in r.stdout.splitlines() if l.startswith('[GNUPG:] ')], 'primaryFingerprints': fprs,
            'releaseSignedSha256': sha256b(rel_bytes), 'release': rel, 'packagesSha256': pk_sha, 'packagesSize': pk_len,
            'stanza': st, 'debSha256': sha256b(debb), 'debSize': len(debb)}


def common_checks(a):
    origins = HTTP_ORIGINS if a.transport == 'http' else HTTPS_ORIGINS
    if a.transport not in ('https', 'http') or a.origin not in origins or a.suite not in ALLOWED_SUITES or a.component not in ALLOWED_COMPONENTS:
        raise Refuse(2, 'origin/transport/suite/component outside the fixed allowlists (http only when explicitly selected)')
    check_version_pin(a.package_version)
    if not os.path.isabs(a.keyring) or not re.fullmatch(r'[0-9a-f]{64}', a.keyring_sha256 or ''):
        raise Refuse(2, '--keyring must be absolute and --keyring-sha256 a pin')
    if sha256b(read_regular(a.keyring, 4 << 20)) != a.keyring_sha256:
        raise Refuse(2, 'keyring sha256 differs from the root pin')
    if not a.allowed_primary_fpr or any(not re.fullmatch(r'[0-9A-Fa-f]{40}', f or '') for f in a.allowed_primary_fpr):
        raise Refuse(2, '--allowed-primary-fpr (40-hex, root input) is required')


def new_private_dir(p):
    if not os.path.isabs(p) or os.path.lexists(p):
        raise Refuse(2, f'{p} must be a NEW absolute path')
    os.mkdir(p, 0o700); os.chmod(p, 0o700)


def curl_get(a, url, out, cap):
    cmd = [a.curl, '-q', '-sS', '--fail', '--proto', '=' + a.transport, '--max-redirs', '0', '--max-filesize', str(cap),
           '--connect-timeout', '30', '--max-time', str(a.http_timeout), '-o', out, url]
    if a.transport == 'https':
        cmd[cmd.index('--max-redirs'):cmd.index('--max-redirs')] = ['--tlsv1.2']
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=a.http_timeout + 30, env=ENV)
    if r.returncode != 0 or not os.path.isfile(out) or os.path.getsize(out) > cap:
        raise Refuse(6, f'download failed or beyond cap: {url}', curl_rc=r.returncode, stderr=r.stderr[-300:])


def cmd_fetch(a):
    common_checks(a)
    new_private_dir(a.out)
    base = f'{a.origin}/dists/{a.suite}'
    urls = {'InRelease': f'{base}/InRelease', 'Packages.xz': f'{base}/{a.component}/binary-{ARCH}/Packages.xz'}
    curl_get(a, urls['InRelease'], os.path.join(a.out, 'InRelease'), CAP_INRELEASE)
    curl_get(a, urls['Packages.xz'], os.path.join(a.out, 'Packages.xz'), CAP_PKGS_XZ)
    pre = os.path.join(a.out, 'precheck'); os.mkdir(pre, 0o700)              # verified metadata names the pool path
    gpgv_release(a, a.keyring, os.path.join(a.out, 'InRelease'), os.path.join(pre, 'Release.signed'))
    rel = parse_release(read_regular(os.path.join(pre, 'Release.signed'), CAP_INRELEASE).decode('utf-8', 'strict'), a.suite, a.component)
    xz = read_regular(os.path.join(a.out, 'Packages.xz'), CAP_PKGS_XZ)
    check_blob(xz, rel['xz'][0], rel['xz'][1], 'Packages.xz')
    st = select_stanza(bounded_unxz(xz, CAP_PKGS), a.component, a.package_version); del xz
    deb_name = os.path.basename(st['Filename']); urls['deb'] = f'{a.origin}/{st["Filename"]}'
    curl_get(a, urls['deb'], os.path.join(a.out, deb_name), CAP_DEB)
    os.unlink(os.path.join(pre, 'Release.signed')); os.rmdir(pre)
    ev = verify_chain(a, a.keyring, os.path.join(a.out, 'InRelease'), os.path.join(a.out, 'Packages.xz'), os.path.join(a.out, deb_name), a.out)
    cv = subprocess.run([a.curl, '--version'], capture_output=True, text=True, env=ENV).stdout.splitlines()[:1]
    receipt = {'format': RECEIPT_FORMAT, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'transport': a.transport,
               'origin': a.origin, 'suite': a.suite, 'component': a.component, 'arch': ARCH, 'package': PACKAGE,
               'packageVersion': a.package_version, 'keyringSha256': a.keyring_sha256,
               'allowedPrimaryFingerprints': sorted({f.upper() for f in a.allowed_primary_fpr}), 'curl': cv, 'urls': urls,
               'files': {n: sha256b(read_regular(os.path.join(a.out, n), CAP_PKGS_XZ)) for n in ('InRelease', 'Release.signed', 'Packages.xz', deb_name)},
               'evidence': ev, 'note': 'host-verified chain; the .deb was never extracted or executed on the host'}
    with open(os.path.join(a.out, 'receipt.json'), 'x') as f:
        json.dump(receipt, f, indent=1, sort_keys=True); f.write('\n')
    with open(os.path.join(a.out, 'SHA256SUMS'), 'x') as f:
        for n in sorted(os.listdir(a.out)):
            if n != 'SHA256SUMS':
                f.write(f'{sha256b(read_regular(os.path.join(a.out, n), CAP_PKGS_XZ))}  {n}\n')
    print(json.dumps({'event': 'bundle-ready', 'out': a.out, 'receiptSha256': sha256b(read_regular(os.path.join(a.out, 'receipt.json'), 1 << 20)),
                      'debSha256': ev['debSha256'], 'primaryFingerprints': ev['primaryFingerprints'], 'packageVersion': a.package_version}))
    return 0


def cmd_qualify(a):
    common_checks(a)
    rec_b = read_regular(os.path.join(a.bundle, 'receipt.json'), 1 << 20)
    if sha256b(rec_b) != a.receipt_sha256:
        raise Refuse(2, 'receipt.json is not the root-pinned receipt')
    rec = json.loads(rec_b); validate_receipt(rec)
    deb_name = os.path.basename(rec['evidence']['stanza']['Filename'])
    if deb_name != f'{PACKAGE}_{filename_version(a.package_version)}_{ARCH}.deb':
        raise Refuse(8, 'receipt names another package file', deb=deb_name)
    for n, h in rec['files'].items():
        if n not in ('InRelease', 'Release.signed', 'Packages.xz', deb_name):
            raise Refuse(2, f'receipt lists an unexpected file {n}')
        if n != 'Release.signed' and sha256b(read_regular(os.path.join(a.bundle, n), CAP_PKGS_XZ)) != h:
            raise Refuse(8, f'bundle file {n} differs from the receipt')
    new_private_dir(a.scratch)
    ev = verify_chain(a, a.keyring, os.path.join(a.bundle, 'InRelease'), os.path.join(a.bundle, 'Packages.xz'),
                      os.path.join(a.bundle, deb_name), a.scratch)               # the GUEST's own keyring
    compare_receipt(rec, a, ev)
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
    check_tool_outputs(v.stdout if v.returncode == 0 else '', k.stdout if k.returncode == 0 else '', a.package_version)
    res = {'format': 'enclave-offline-b3sum-qualification/r3', 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
           'receiptSha256': a.receipt_sha256, 'packageVersion': a.package_version, 'evidence': ev,
           'tool': {'path': tp, 'sha256': sha256b(tool), 'version': v.stdout.strip()},
           'kat': {'input': 'empty', 'expect': BLAKE3_EMPTY, 'got': k.stdout.strip()}, 'proposed': {'GSI_B3SUM_SHA256': sha256b(tool)},
           'scope': 'provenance + identity + version + empty-input KAT only; native qualification is Q4 (all 4 state outputs = manifest BLAKE3)'}
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
        p.add_argument('--package-version', required=True)
        p.add_argument('--origin', required=True); p.add_argument('--suite', required=True); p.add_argument('--component', required=True)
        p.add_argument('--transport', choices=('https', 'http'), default='https')
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
    except Exception as e:                                                       # S2: never a traceback, always a typed refusal
        print(json.dumps({'event': 'refused', 'code': 2, 'reason': f'unexpected {type(e).__name__}: {e}'})); return 2


if __name__ == '__main__':
    sys.exit(main())

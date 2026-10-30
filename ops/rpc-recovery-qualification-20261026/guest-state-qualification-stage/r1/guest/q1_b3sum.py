#!/usr/bin/python3 -I
"""q1_b3sum.py (guest-state-qualification-stage/r1; PREPARED, never run by Claude). GUEST (Ubuntu noble), root, uses the guest's
configured apt sources (a root live action: network). Q1 of logs/claude-guest-state-install-review.md. NOTHING IS INSTALLED.
  1. apt-cache policy b3sum: the Candidate MUST be exactly --expect-version (1.2.0-1); otherwise stop (no other version, no guessing).
  2. apt-cache show b3sum=<ver>: record the Packages stanza (Package, Version, Architecture, Filename, Size, SHA256, Source).
  3. apt-get download b3sum=<ver> into a fresh root 0700 scratch dir (apt verifies signed InRelease -> Packages -> .deb hashes).
  4. Independent chain record: gpgv each apt InRelease with --keyring; find the Packages list holding this stanza; its sha256 must be
     listed in the signed InRelease; the .deb sha256/size must equal the stanza. Any gap -> stop (fail closed).
  5. dpkg-deb -I/-c recorded; dpkg-deb -x into scratch (NO install); the extracted usr/bin/b3sum sha256 is the proposed pin.
  6. `b3sum --version` must start with "b3sum 1.2.0"; known answer: BLAKE3("") = af1349b9...3262 (the value guest_state.py pins).
  7. Optional official vectors: ONLY if the signed source package (apt-get source --download-only) contains test_vectors.json, read it
     IN MEMORY (no tar extraction to disk) and check every case's 32-byte hash; otherwise record "absent" (no invented vectors).
  8. findmnt OPTIONS of the holder mount (install executes its verified copy there: noexec would refuse).
Writes ONLY under --scratch. Prints the gsi.env proposal (GSI_B3SUM_SHA256) for ROOT to review; it does not write /etc.
Exit 0 all mandatory checks pass; 2 refused precondition (e.g. version unavailable); 1 a check failed.
"""
import argparse, glob, hashlib, io, json, os, re, subprocess, sys, tarfile, time

BLAKE3_EMPTY = 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262'
ENV = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LC_ALL': 'C', 'DEBIAN_FRONTEND': 'noninteractive'}


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def sha256(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def run(cmd, timeout, cwd=None):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=ENV, cwd=cwd, stdin=subprocess.DEVNULL)
    return r.returncode, r.stdout, r.stderr


def stanza(text, version):
    for block in re.split(r'\n\s*\n', text):
        f = {}
        for line in block.splitlines():
            m = re.match(r'^([A-Za-z0-9-]+):\s*(.*)$', line)
            if m:
                f[m.group(1)] = m.group(2)
        if f.get('Package') == 'b3sum' and f.get('Version') == version:
            return f
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--expect-version', default='1.2.0-1')
    ap.add_argument('--keyring', default='/usr/share/keyrings/ubuntu-archive-keyring.gpg')
    ap.add_argument('--scratch', required=True, help='NEW root 0700 dir (created here)')
    ap.add_argument('--holder-mount', default='/srv/enclave-base-holder')
    ap.add_argument('--apt-timeout', type=int, default=600)
    ap.add_argument('--vectors', choices=('try', 'skip'), default='try')
    a = ap.parse_args()
    if os.getuid() != 0:
        print('run as root'); sys.exit(2)
    if os.path.lexists(a.scratch):
        print('--scratch must not exist'); sys.exit(2)
    os.makedirs(a.scratch, mode=0o700)
    rec = {'format': 'enclave-guest-qualification-q1/r1', 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'checks': {}}
    bad = []

    def check(name, ok, **kw):
        rec['checks'][name] = {'ok': bool(ok), **kw}
        if not ok:
            bad.append(name)

    def finish(code):
        rec['result'] = 'PASS' if not bad and code == 0 else 'FAIL'; rec['failed'] = bad
        with open(os.path.join(a.scratch, 'q1-result.json'), 'x') as f:
            json.dump(rec, f, indent=1); f.write('\n')
        print(json.dumps({'event': 'q1-result', 'result': rec['result'], 'failed': bad,
                          'proposed_GSI_B3SUM_SHA256': rec.get('b3sumSha256')}), flush=True)
        sys.exit(code if code else (0 if not bad else 1))

    rc, out, err = run(['apt-cache', 'policy', 'b3sum'], 120)
    rec['aptPolicy'] = out
    cand = re.search(r'Candidate:\s*(\S+)', out)
    if rc != 0 or not cand or cand.group(1) != a.expect_version:
        check('candidate-version', False, got=cand.group(1) if cand else None, expect=a.expect_version)
        finish(2)                                                     # fail closed: no other version, no guessed hash
    rc, out, err = run(['apt-cache', 'show', f'b3sum={a.expect_version}'], 120)
    st = stanza(out, a.expect_version)
    rec['stanza'] = st
    if not st or not re.fullmatch(r'[0-9a-f]{64}', st.get('SHA256', '')):
        check('packages-stanza', False); finish(2)
    dl = os.path.join(a.scratch, 'download'); os.mkdir(dl, 0o700)
    rc, out, err = run(['apt-get', 'download', f'b3sum={a.expect_version}'], a.apt_timeout, cwd=dl)
    rec['aptDownload'] = {'rc': rc, 'out': (out + err)[-3000:]}
    debs = glob.glob(os.path.join(dl, '*.deb'))
    check('apt-download', rc == 0 and len(debs) == 1, debs=[os.path.basename(d) for d in debs])
    if bad:
        finish(1)
    deb = debs[0]
    rec['debSha256'] = sha256(deb); rec['debSize'] = os.path.getsize(deb)
    check('deb-equals-stanza', rec['debSha256'] == st['SHA256'] and str(rec['debSize']) == st.get('Size'))
    # independent signature chain: InRelease (gpgv) -> Packages list (sha256 listed) -> stanza -> .deb
    chain = []
    for pk in sorted(glob.glob('/var/lib/apt/lists/*_Packages')):
        with open(pk, 'rb') as f:
            data = f.read()
        if f'Filename: {st["Filename"]}\n'.encode() not in data or f'SHA256: {st["SHA256"]}\n'.encode() not in data:
            continue
        prefix = pk.split('_dists_')[0] + '_dists_' + pk.split('_dists_')[1].split('_')[0]
        inrel = glob.glob(prefix + '_InRelease')
        entry = {'packagesList': pk, 'packagesSha256': sha256_bytes(data), 'inRelease': inrel}
        if len(inrel) == 1:
            grc, gout, gerr = run(['gpgv', '--keyring', a.keyring, inrel[0]], 120)
            txt = open(inrel[0], encoding='utf-8', errors='replace').read()
            entry['gpgvRc'] = grc; entry['gpgvOut'] = (gout + gerr)[-1500:]
            entry['packagesHashListed'] = re.search(r'^\s*' + entry['packagesSha256'] + r'\s+\d+\s+\S+/binary-[^/]+/Packages\s*$', txt, re.M) is not None
        chain.append(entry)
    rec['signatureChain'] = chain
    check('signature-chain', any(e.get('gpgvRc') == 0 and e.get('packagesHashListed') for e in chain),
          note='requires an uncompressed Packages list whose sha256 appears in a gpgv-verified InRelease')
    rc, out, err = run(['dpkg-deb', '-I', deb], 60); rec['debControl'] = out[-3000:]
    rc2, out2, err2 = run(['dpkg-deb', '-c', deb], 60); rec['debContents'] = out2[-3000:]
    ex = os.path.join(a.scratch, 'extract'); os.mkdir(ex, 0o700)
    rc3, out3, err3 = run(['dpkg-deb', '-x', deb, ex], 120)             # extract only; NOT installed
    tool = os.path.join(ex, 'usr', 'bin', 'b3sum')
    check('extracted-tool', rc3 == 0 and os.path.isfile(tool) and not os.path.islink(tool), err=err3[-500:])
    if bad:
        finish(1)
    rec['b3sumSha256'] = sha256(tool)
    rc, vout, verr = run([tool, '--version'], 30)
    check('tool-version', rc == 0 and vout.strip().startswith('b3sum 1.2.0'), got=(vout + verr).strip()[:200])
    empty = os.path.join(a.scratch, 'kat-empty'); open(empty, 'xb').close()
    rc, kout, kerr = run([tool, '--no-names', empty], 30)
    check('kat-empty', rc == 0 and kout.strip() == BLAKE3_EMPTY, got=kout.strip())
    if a.vectors == 'try':
        rec['vectors'] = vectors(a, tool, st)
        if rec['vectors'].get('status') == 'checked':
            check('official-vectors', rec['vectors']['failed'] == 0, **{k: rec['vectors'][k] for k in ('cases', 'failed')})
    rc, mout, _ = run(['findmnt', '-no', 'OPTIONS', a.holder_mount], 30)
    rec['holderMountOptions'] = mout.strip()
    check('holder-not-noexec', rc == 0 and 'noexec' not in mout.split(','), options=mout.strip())
    rec['gsiEnvProposal'] = {'GSI_B3SUM_SHA256': rec['b3sumSha256'],
                             'note': 'root copies the extracted tool to its reviewed path and writes /etc/enclave-rpc/gsi.env; '
                                     'the native qualification is install\'s own result: all 4 outputs (incl. mdbx.dat) = manifest pins'}
    finish(0)


def vectors(a, tool, st):
    """official BLAKE3 test vectors, only from the signed source package; never invented"""
    src = st.get('Source', 'b3sum').split()[0]
    sd = os.path.join(a.scratch, 'source'); os.mkdir(sd, 0o700)
    rc, out, err = run(['apt-get', 'source', '--download-only', f'{src}'], a.apt_timeout, cwd=sd)
    res = {'sourcePackage': src, 'aptRc': rc, 'aptOut': (out + err)[-1500:]}
    if rc != 0:
        res['status'] = 'absent (source package not downloadable)'; return res
    found = None
    for t in sorted(glob.glob(os.path.join(sd, '*.tar.*'))):
        try:
            with tarfile.open(t, 'r:*') as tf:                         # read the one member in memory; nothing is extracted
                for m in tf.getmembers():
                    if m.isfile() and m.name.endswith('test_vectors/test_vectors.json') and m.size < 10 << 20:
                        found = (t, m.name, tf.extractfile(m).read()); break
        except (tarfile.TarError, OSError) as e:
            res.setdefault('tarErrors', []).append(f'{os.path.basename(t)}: {e}')
        if found:
            break
    if not found:
        res['status'] = 'absent (no test_vectors.json in the signed source)'; return res
    res['vectorsFile'] = f'{os.path.basename(found[0])}:{found[1]}'; res['vectorsSha256'] = sha256_bytes(found[2])
    cases, failed = json.loads(found[2]).get('cases', []), 0
    vd = os.path.join(a.scratch, 'vectors'); os.mkdir(vd, 0o700)
    for c in cases:
        n = int(c['input_len']); p = os.path.join(vd, f'in-{n}')
        with open(p, 'xb') as f:
            f.write(bytes(i % 251 for i in range(n)))
        rc, out, _ = run([tool, '--no-names', p], 60)
        if rc != 0 or out.strip() != c['hash'][:64]:
            failed += 1
    res.update(status='checked', cases=len(cases), failed=failed)
    return res


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Tests for b3bundle.py r2's verification logic (PREPARED; root runs them; Claude never did). Tiny synthetic fixtures and MOCKED gpgv
status / subprocess only: no network, no gpgv, no curl, no dpkg, no real package. They are NOT a qualification of the real archive chain
or the tool. r1's 14 tests are kept (adapted to the r2 signatures) plus r2 regressions: weak digest signatures (S4), changed trust
inputs (S3), the package-version pin (S1), typed invalid-input failures (S2) and explicit-only HTTP transport (B1)."""
import argparse, contextlib, importlib.util, io, json, lzma, os, tarfile, tempfile, unittest
from pathlib import Path
from unittest import mock

SPEC = importlib.util.spec_from_file_location('b3', Path(__file__).resolve().parent.parent / 'b3bundle.py')
b3 = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(b3)
FPR = '0123456789ABCDEF0123456789ABCDEF01234567'          # SYNTHETIC test value; real fingerprints are root inputs only
OTHER = 'A' * 40
VER = '1.2.0-1'


def status(*lines):
    return ''.join(f'[GNUPG:] {l}\n' for l in lines)


def validsig(hashalgo='10', fpr=FPR):
    return f'VALIDSIG {fpr} 2024-01-01 1704067200 0 4 0 1 {hashalgo} 01 {fpr}'


GOOD_STATUS = status('NEWSIG', 'KEY_CONSIDERED ' + FPR + ' 0', 'SIG_ID x 2024-01-01 1', 'GOODSIG 89ABCDEF01234567 Test', validsig())


def release(xz_sha, xz_size, plain=None, suite='noble', codename='noble', extra=''):
    lines = [f'Origin: Ubuntu', f'Suite: {suite}', f'Codename: {codename}', 'Date: Thu, 25 Apr 2024 15:10:33 UTC', 'SHA256:',
             f' {xz_sha} {xz_size} universe/binary-amd64/Packages.xz']
    if plain:
        lines.append(f' {plain[0]} {plain[1]} universe/binary-amd64/Packages')
    return '\n'.join(lines) + '\n' + extra


def stanza(version=VER, arch='amd64', filename='pool/universe/r/rust-b3sum/b3sum_1.2.0-1_amd64.deb', size='12345', sha='b' * 64):
    return (f'Package: b3sum\nArchitecture: {arch}\nVersion: {version}\nSource: rust-b3sum\nFilename: {filename}\nSize: {size}\n'
            f'SHA256: {sha}\nDescription: test\n')


class Signature(unittest.TestCase):
    def test_good_status_with_pinned_key(self):
        self.assertEqual(b3.parse_gpgv_status(GOOD_STATUS, [FPR]), [FPR])

    def test_bad_statuses_refuse(self):
        for bad in ('BADSIG 89ABCDEF01234567 x', 'ERRSIG 89ABCDEF01234567 1 10 01 1704067200 9 -', 'NO_PUBKEY 89ABCDEF01234567',
                    'EXPKEYSIG 89ABCDEF01234567 x', 'REVKEYSIG 89ABCDEF01234567 x', 'EXPSIG 89ABCDEF01234567 x'):
            with self.assertRaises(b3.Refuse) as c:
                b3.parse_gpgv_status(GOOD_STATUS + status(bad), [FPR])
            self.assertEqual(c.exception.code, 7, bad)

    def test_missing_or_unpinned_signature_refuses(self):
        for st, allowed in (('', [FPR]), (status('NEWSIG'), [FPR]), (GOOD_STATUS, [OTHER]), (GOOD_STATUS, []),
                            (status('GOODSIG x y'), [FPR]), (status(f'VALIDSIG {FPR}'), [FPR])):
            with self.assertRaises(b3.Refuse):
                b3.parse_gpgv_status(st, allowed)

    def test_weak_digest_signatures_refuse(self):                              # S4 regression
        for algo in ('1', '2', '3', '11', '0', 'SHA256', '08'):                 # MD5, SHA-1, RIPEMD-160, SHA-224, junk
            st = status('GOODSIG 89ABCDEF01234567 Test', validsig(algo))
            with self.assertRaises(b3.Refuse, msg=algo) as c:
                b3.parse_gpgv_status(st, [FPR])
            self.assertEqual(c.exception.code, 7, algo)
        mixed = status('GOODSIG 89ABCDEF01234567 Test', validsig('10'), 'GOODSIG 89ABCDEF01234567 Test', validsig('2'))
        with self.assertRaises(b3.Refuse):
            b3.parse_gpgv_status(mixed, [FPR])                                  # one weak signature among good ones refuses

    def test_sha2_digests_accepted(self):
        for algo in ('8', '9', '10'):
            self.assertEqual(b3.parse_gpgv_status(status('GOODSIG 89ABCDEF01234567 Test', validsig(algo)), [FPR]), [FPR])


class Metadata(unittest.TestCase):
    def test_release_entries(self):
        r = b3.parse_release(release('c' * 64, 10, plain=('d' * 64, 20)), 'noble', 'universe')
        self.assertEqual((r['xz'], r['plain']), (['c' * 64, 10], ['d' * 64, 20]))

    def test_release_refusals(self):
        for text, suite in ((release('c' * 64, 10, suite='noble-updates'), 'noble'), (release('c' * 64, 10, codename='jammy'), 'noble'),
                            (release('c' * 64, 10).replace('Packages.xz', 'Packages.gz'), 'noble'),
                            (release('zz', 10), 'noble'), (release('c' * 64, 10) + ' ' + 'c' * 64 + ' 10 universe/binary-amd64/Packages.xz\n', 'noble')):
            with self.assertRaises(b3.Refuse):
                b3.parse_release(text, suite, 'universe')

    def test_exact_stanza_selected(self):
        txt = stanza() + '\n' + stanza(version='1.1.0-1') + '\n' + stanza(arch='arm64', filename='pool/universe/r/rust-b3sum/b3sum_1.2.0-1_arm64.deb')
        self.assertEqual(b3.select_stanza(txt, 'universe', VER)['Version'], VER)
        self.assertEqual(b3.select_stanza(txt.encode(), 'universe', VER)['Version'], VER)

    def test_missing_or_duplicate_version_refuses(self):
        for txt in (stanza(version='1.1.0-1'), '', stanza() + '\n' + stanza()):
            with self.assertRaises(b3.Refuse) as c:
                b3.select_stanza(txt, 'universe', VER)
            self.assertEqual(c.exception.code, 8)

    def test_filename_traversal_and_malformed_fields_refuse(self):
        for kw in (dict(filename='pool/universe/r/../../etc/b3sum_1.2.0-1_amd64.deb'), dict(filename='/pool/universe/r/x/b3sum_1.2.0-1_amd64.deb'),
                   dict(filename='pool/universe/r/rust-b3sum//b3sum_1.2.0-1_amd64.deb'), dict(filename='pool/main/r/rust-b3sum/b3sum_1.2.0-1_amd64.deb'),
                   dict(filename='pool/universe/r/rust-b3sum/other_1.2.0-1_amd64.deb'), dict(filename='http://x/b3sum_1.2.0-1_amd64.deb'),
                   dict(size='-1'), dict(size=str(64 << 20)), dict(sha='z' * 64)):
            with self.assertRaises(b3.Refuse, msg=str(kw)):
                b3.select_stanza(stanza(**kw), 'universe', VER)

    def test_bytes_scan_matches_exact_package_only(self):                     # B2: bytes scan, decode only b3sum stanzas
        other = stanza().replace('Package: b3sum\n', 'Package: b3sum-extra\n')
        noise = 'Package: zz\nVersion: 1\nDescription: \xff-free\n'
        self.assertEqual(b3.select_stanza((other + '\n' + noise + '\n' + stanza()).encode(), 'universe', VER)['Package'], 'b3sum')
        with self.assertRaises(b3.Refuse) as c:                                  # fields hidden before Package refuse
            b3.select_stanza('Filename: pool/universe/r/x/evil.deb\n' + stanza(), 'universe', VER)
        self.assertEqual(c.exception.code, 8)
        with self.assertRaises(b3.Refuse) as c:                                  # duplicated field inside the stanza refuses
            b3.select_stanza(stanza() + 'SHA256: ' + 'c' * 64 + '\n', 'universe', VER)
        self.assertEqual(c.exception.code, 8)
        with self.assertRaises(b3.Refuse) as c:                                  # non-UTF-8 b3sum stanza is a typed refusal
            b3.select_stanza(stanza().encode().replace(b'Description: test', b'Description: \xff'), 'universe', VER)
        self.assertEqual(c.exception.code, 8)


class VersionPin(unittest.TestCase):                                            # S1 regressions
    def test_version_pin_syntax(self):
        for v in ('1.2.0-1', '1:1.2.0-1', '1.2.0', '1.2.0-1ubuntu0.24.04.1', '1.2.0~rc1-1'):
            self.assertEqual(b3.check_version_pin(v), v)
        for v in ('', None, ' 1.2.0-1', '1.2.0-1\n', '1.2.0-1;x', '../1.2.0-1', 'v1.2.0', '1.2.0-1/..', '1.2.0-', ':1.2.0-1', '1.2.0-1 '):
            with self.assertRaises(b3.Refuse, msg=repr(v)) as c:
                b3.check_version_pin(v)
            self.assertEqual(c.exception.code, 2)

    def test_stanza_follows_the_pin(self):
        txt = stanza() + '\n' + stanza(version='1.1.0-1', filename='pool/universe/r/rust-b3sum/b3sum_1.1.0-1_amd64.deb')
        self.assertEqual(b3.select_stanza(txt, 'universe', '1.1.0-1')['Version'], '1.1.0-1')
        with self.assertRaises(b3.Refuse) as c:
            b3.select_stanza(txt, 'universe', '1.3.0-1')
        self.assertEqual(c.exception.code, 8)
        with self.assertRaises(b3.Refuse):                                       # pin 1.1.0-1 must not accept a 1.2.0-1 file name
            b3.select_stanza(stanza(version='1.1.0-1'), 'universe', '1.1.0-1')
        ep = stanza(version='1:1.2.0-1')                                         # epoch: not part of the pool file name
        self.assertEqual(b3.select_stanza(ep, 'universe', '1:1.2.0-1')['Version'], '1:1.2.0-1')
        with self.assertRaises(b3.Refuse):
            b3.select_stanza(ep, 'universe', VER)

    def test_tool_version_derived_from_pin(self):
        k = b3.BLAKE3_EMPTY + '\n'
        for out, pin in (('b3sum 1.2.0\n', VER), ('b3sum 1.2.0\n', '1:1.2.0-1'), ('b3sum 1.2.0 (extra)\n', VER), ('b3sum 1.1.0\n', '1.1.0-1')):
            b3.check_tool_outputs(out, k, pin)
        for out, pin in (('b3sum 1.2.01\n', VER), ('b3sum 1.2.0-x\n', VER), ('b3sum 1.2\n', VER), ('b3sum 1.2.0\n', '1.1.0-1'),
                         ('xb3sum 1.2.0\n', VER), ('', VER)):
            with self.assertRaises(b3.Refuse, msg=out) as c:
                b3.check_tool_outputs(out, k, pin)
            self.assertEqual(c.exception.code, 9)


class Digests(unittest.TestCase):
    def test_wrong_digest_refused_before_decompression(self):
        blob = lzma.compress(b'Package: b3sum\n', format=lzma.FORMAT_XZ)
        with mock.patch.object(b3, 'bounded_unxz', side_effect=AssertionError('decompressed before the digest check')):
            with self.assertRaises(b3.Refuse) as c:
                b3.check_blob(blob, 'e' * 64, len(blob), 'Packages.xz')
                b3.bounded_unxz(blob, 1 << 20)
        self.assertEqual(c.exception.code, 8)
        with self.assertRaises(b3.Refuse):
            b3.check_blob(blob, b3.sha256b(blob), len(blob) + 1, 'Packages.xz')
        b3.check_blob(blob, b3.sha256b(blob), len(blob), 'Packages.xz')

    def test_decompression_cap_and_truncation(self):
        bomb = lzma.compress(b'\0' * (4 << 20), format=lzma.FORMAT_XZ)
        with self.assertRaises(b3.Refuse):
            b3.bounded_unxz(bomb, 1 << 20)
        with self.assertRaises(b3.Refuse):
            b3.bounded_unxz(bomb[:-8], 8 << 20)
        self.assertEqual(len(b3.bounded_unxz(bomb, 8 << 20)), 4 << 20)


class ToolExtraction(unittest.TestCase):
    @staticmethod
    def tar(members):
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode='w') as tf:
            for name, kind, data, link in members:
                ti = tarfile.TarInfo(name); ti.type = kind; ti.linkname = link or ''; ti.size = len(data or b'')
                tf.addfile(ti, io.BytesIO(data) if data else None)
        return buf.getvalue()

    def test_only_the_tool_member_is_returned(self):
        t = self.tar([('./usr/bin/b3sum', tarfile.REGTYPE, b'ELF-tool', None), ('./usr/share/doc/b3sum/copyright', tarfile.REGTYPE, b'c', None)])
        self.assertEqual(b3.extract_only_tool(t), b'ELF-tool')

    def test_hostile_payloads_refused(self):
        for members in ([('../usr/bin/b3sum', tarfile.REGTYPE, b'x', None)], [('/usr/bin/b3sum', tarfile.REGTYPE, b'x', None)],
                        [('./usr/bin/b3sum', tarfile.SYMTYPE, None, '/bin/sh')], [('./usr/bin/b3sum', tarfile.LNKTYPE, None, './etc/x')],
                        [('./usr/bin/b3sum', tarfile.REGTYPE, b'a', None), ('usr/bin/b3sum', tarfile.REGTYPE, b'b', None)],
                        [('./usr/bin/other', tarfile.REGTYPE, b'x', None)], [('./usr/bin/b3sum', tarfile.REGTYPE, b'', None)],
                        [('./usr/bin/b3sum', tarfile.REGTYPE, b'x', None), ('./a/../../x', tarfile.REGTYPE, b'y', None)]):
            with self.assertRaises(b3.Refuse, msg=str(members)) as c:
                b3.extract_only_tool(self.tar(members))
            self.assertEqual(c.exception.code, 9)

    def test_version_and_kat(self):
        b3.check_tool_outputs('b3sum 1.2.0\n', b3.BLAKE3_EMPTY + '\n', VER)
        for v, k in (('b3sum 1.3.0', b3.BLAKE3_EMPTY), ('', b3.BLAKE3_EMPTY), ('b3sum 1.2.0', '0' * 64), ('b3sum 1.2.0', '')):
            with self.assertRaises(b3.Refuse):
                b3.check_tool_outputs(v, k, VER)

    def test_malformed_tar_is_typed_refusal(self):                             # S2 regression: TarError -> Refuse 9, no traceback
        good = self.tar([('./usr/bin/b3sum', tarfile.REGTYPE, b'E' * 4000, None)])
        for blob in (b'', b'not a tar archive ' * 64, good[:700]):
            with self.assertRaises(b3.Refuse, msg=repr(blob[:20])) as c:
                b3.extract_only_tool(blob)
            self.assertEqual(c.exception.code, 9)


def ns(**kw):
    d = dict(transport='https', origin='https://archive.ubuntu.com/ubuntu', suite='noble', component='universe', keyring='/x',
             keyring_sha256='0' * 64, allowed_primary_fpr=[FPR], package_version=VER)
    d.update(kw); return argparse.Namespace(**d)


EV = {'stanza': {'Package': 'b3sum', 'Version': VER, 'Filename': 'pool/universe/r/rust-b3sum/b3sum_1.2.0-1_amd64.deb'},
      'debSha256': 'b' * 64, 'releaseSignedSha256': 'c' * 64, 'packagesSha256': 'd' * 64, 'primaryFingerprints': [FPR]}


def receipt(**kw):
    r = {'format': b3.RECEIPT_FORMAT, 'transport': 'https', 'origin': 'https://archive.ubuntu.com/ubuntu', 'suite': 'noble',
         'component': 'universe', 'keyringSha256': '0' * 64, 'packageVersion': VER, 'allowedPrimaryFingerprints': [FPR],
         'files': {'InRelease': 'a' * 64}, 'evidence': json.loads(json.dumps(EV))}
    r.update(kw); return r


class Receipt(unittest.TestCase):                                              # S2/S3 regressions
    def test_malformed_receipts_are_typed_refusals(self):
        b3.validate_receipt(receipt())
        bad = [[], {}, 'x', receipt(format='enclave-offline-b3sum-bundle/r1'), receipt(evidence=[]), receipt(evidence={'stanza': 'x'}),
               receipt(evidence={'stanza': {'Filename': 1}, 'primaryFingerprints': []}), receipt(files=[]), receipt(files={'x': 1}),
               receipt(allowedPrimaryFingerprints=FPR), receipt(packageVersion=None)]
        r = receipt(); del r['allowedPrimaryFingerprints']; bad.append(r)
        r = receipt(); del r['evidence']['primaryFingerprints']; bad.append(r)
        for rec in bad:
            with self.assertRaises(b3.Refuse, msg=str(rec)[:120]) as c:
                b3.validate_receipt(rec)
            self.assertEqual(c.exception.code, 2)

    def test_same_trust_inputs_pass(self):
        b3.compare_receipt(receipt(), ns(), json.loads(json.dumps(EV)))
        b3.compare_receipt(receipt(), ns(allowed_primary_fpr=[FPR.lower(), FPR]), json.loads(json.dumps(EV)))

    def test_changed_trust_inputs_refuse(self):
        for kw in (dict(allowed_primary_fpr=[FPR, OTHER]), dict(allowed_primary_fpr=[OTHER]), dict(keyring_sha256='1' * 64),
                   dict(package_version='1.2.0-2'), dict(transport='http', origin='http://archive.ubuntu.com/ubuntu'),
                   dict(origin='https://security.ubuntu.com/ubuntu'), dict(suite='noble-updates'), dict(component='main')):
            with self.assertRaises(b3.Refuse, msg=str(kw)) as c:
                b3.compare_receipt(receipt(), ns(**kw), json.loads(json.dumps(EV)))
            self.assertEqual(c.exception.code, 2, kw)
        with self.assertRaises(b3.Refuse) as c:                                  # receipt recorded a wider allowed set than this run
            b3.compare_receipt(receipt(allowedPrimaryFingerprints=sorted([FPR, OTHER])), ns(), json.loads(json.dumps(EV)))
        self.assertEqual(c.exception.code, 2)

    def test_changed_evidence_refuses(self):
        for k, v in (('primaryFingerprints', [OTHER]), ('primaryFingerprints', sorted([FPR, OTHER])), ('debSha256', 'e' * 64),
                     ('releaseSignedSha256', 'e' * 64), ('packagesSha256', 'e' * 64), ('stanza', {**EV['stanza'], 'Version': '1.2.0-2'})):
            ev = json.loads(json.dumps(EV)); ev[k] = v
            with self.assertRaises(b3.Refuse, msg=k) as c:
                b3.compare_receipt(receipt(), ns(), ev)
            self.assertEqual(c.exception.code, 8, k)


FETCH_ARGV = ['fetch', '--keyring', '/k', '--keyring-sha256', '0' * 64, '--allowed-primary-fpr', FPR, '--package-version', VER,
              '--origin', 'https://archive.ubuntu.com/ubuntu', '--suite', 'noble', '--component', 'universe', '--out', '/nonexistent-out']


class Inputs(unittest.TestCase):
    def test_allowlists_and_pins(self):
        with tempfile.TemporaryDirectory() as t:
            k = os.path.join(t, 'keyring.gpg'); Path(k).write_bytes(b'keyring-bytes')
            good = ns(keyring=k, keyring_sha256=b3.sha256b(b'keyring-bytes'))
            b3.common_checks(good)
            for bad in (dict(origin='http://archive.ubuntu.com/ubuntu'), dict(origin='https://mirror.example/ubuntu'), dict(suite='jammy'),
                        dict(component='multiverse'), dict(keyring_sha256='1' * 64), dict(keyring='keyring.gpg'),
                        dict(allowed_primary_fpr=[]), dict(allowed_primary_fpr=['XYZ']), dict(package_version='1.2.0-1;x'),
                        dict(package_version=None)):
                with self.assertRaises(b3.Refuse, msg=str(bad)):
                    b3.common_checks(argparse.Namespace(**{**vars(good), **bad}))
            os.symlink(k, os.path.join(t, 'link.gpg'))
            with self.assertRaises((b3.Refuse, OSError)):
                b3.common_checks(argparse.Namespace(**{**vars(good), 'keyring': os.path.join(t, 'link.gpg')}))

    def test_http_only_when_explicit_and_exact(self):                          # B1: HTTPS default; HTTP only explicit + exact origins
        with tempfile.TemporaryDirectory() as t:
            k = os.path.join(t, 'keyring.gpg'); Path(k).write_bytes(b'keyring-bytes')
            pin = dict(keyring=k, keyring_sha256=b3.sha256b(b'keyring-bytes'))
            for o in b3.HTTP_ORIGINS:
                b3.common_checks(ns(transport='http', origin=o, **pin))
            for kw in (dict(transport='https', origin='http://archive.ubuntu.com/ubuntu'), dict(transport='http', origin='https://archive.ubuntu.com/ubuntu'),
                       dict(transport='http', origin='http://mirror.example/ubuntu'), dict(transport='http', origin='http://archive.ubuntu.com/ubuntu/'),
                       dict(transport='http', origin='http://ports.ubuntu.com/ubuntu-ports'), dict(transport='ftp', origin='http://archive.ubuntu.com/ubuntu')):
                with self.assertRaises(b3.Refuse, msg=str(kw)) as c:
                    b3.common_checks(ns(**{**kw, **pin}))
                self.assertEqual(c.exception.code, 2)
        seen = []
        with mock.patch.object(b3, 'cmd_fetch', side_effect=lambda a: seen.append(a.transport) or 0):
            self.assertEqual(b3.main(FETCH_ARGV), 0)
            self.assertEqual(b3.main(FETCH_ARGV + ['--transport', 'http']), 0)
        self.assertEqual(seen, ['https', 'http'])                                # default stays https

    def test_curl_scheme_matches_transport_and_never_redirects(self):
        with tempfile.TemporaryDirectory() as t:
            out = os.path.join(t, 'f'); Path(out).write_bytes(b'x')
            for tr, url in (('https', 'https://archive.ubuntu.com/ubuntu/dists/noble/InRelease'), ('http', 'http://archive.ubuntu.com/ubuntu/dists/noble/InRelease')):
                with mock.patch.object(b3.subprocess, 'run', return_value=mock.Mock(returncode=0, stderr='')) as run:
                    b3.curl_get(argparse.Namespace(curl='/usr/bin/curl', transport=tr, http_timeout=60), url, out, 1 << 20)
                cmd = run.call_args[0][0]
                self.assertEqual(cmd[cmd.index('--proto') + 1], '=' + tr)
                self.assertEqual(cmd[cmd.index('--max-redirs') + 1], '0')
                self.assertNotIn('-L', cmd); self.assertNotIn('--location', cmd)
                self.assertEqual('--tlsv1.2' in cmd, tr == 'https')
            with mock.patch.object(b3.subprocess, 'run', return_value=mock.Mock(returncode=47, stderr='redirect')):
                with self.assertRaises(b3.Refuse) as c:
                    b3.curl_get(argparse.Namespace(curl='/usr/bin/curl', transport='https', http_timeout=60), 'https://x/y', out, 1 << 20)
                self.assertEqual(c.exception.code, 6)


class Failures(unittest.TestCase):                                             # S2: never a traceback from main
    def test_unexpected_exceptions_are_typed_rc2(self):
        for exc in (TypeError('t'), AttributeError('a'), IndexError('i'), json.JSONDecodeError('j', '', 0), b3.tarfile.ReadError('r')):
            buf = io.StringIO()
            with mock.patch.object(b3, 'cmd_fetch', side_effect=exc), contextlib.redirect_stdout(buf):
                self.assertEqual(b3.main(FETCH_ARGV), 2, repr(exc))
            self.assertEqual(json.loads(buf.getvalue())['event'], 'refused')
        buf = io.StringIO()
        with mock.patch.object(b3, 'cmd_fetch', side_effect=b3.Refuse(7, 'x')), contextlib.redirect_stdout(buf):
            self.assertEqual(b3.main(FETCH_ARGV), 7)


if __name__ == '__main__':
    unittest.main(verbosity=2)

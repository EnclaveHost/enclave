#!/usr/bin/env python3
"""Tests for b3bundle.py's verification logic (PREPARED; root runs them; Claude never did). Tiny synthetic fixtures and MOCKED gpgv
status text only: no network, no gpgv, no dpkg, no real package. They are NOT a qualification of the real archive chain or the tool."""
import argparse, importlib.util, io, lzma, os, tarfile, tempfile, unittest
from pathlib import Path
from unittest import mock

SPEC = importlib.util.spec_from_file_location('b3', Path(__file__).resolve().parent.parent / 'b3bundle.py')
b3 = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(b3)
FPR = '0123456789ABCDEF0123456789ABCDEF01234567'          # SYNTHETIC test value; real fingerprints are root inputs only
OTHER = 'A' * 40


def status(*lines):
    return ''.join(f'[GNUPG:] {l}\n' for l in lines)


GOOD_STATUS = status('NEWSIG', 'KEY_CONSIDERED ' + FPR + ' 0', 'SIG_ID x 2024-01-01 1', 'GOODSIG 89ABCDEF01234567 Test',
                     f'VALIDSIG {FPR} 2024-01-01 1704067200 0 4 0 1 10 01 {FPR}')


def release(xz_sha, xz_size, plain=None, suite='noble', codename='noble', extra=''):
    lines = [f'Origin: Ubuntu', f'Suite: {suite}', f'Codename: {codename}', 'Date: Thu, 25 Apr 2024 15:10:33 UTC', 'SHA256:',
             f' {xz_sha} {xz_size} universe/binary-amd64/Packages.xz']
    if plain:
        lines.append(f' {plain[0]} {plain[1]} universe/binary-amd64/Packages')
    return '\n'.join(lines) + '\n' + extra


def stanza(version='1.2.0-1', arch='amd64', filename='pool/universe/r/rust-b3sum/b3sum_1.2.0-1_amd64.deb', size='12345', sha='b' * 64):
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


class Metadata(unittest.TestCase):
    def test_release_entries(self):
        r = b3.parse_release(release('c' * 64, 10, plain=('d' * 64, 20)), 'noble', 'universe')
        self.assertEqual((r['xz'], r['plain']), (('c' * 64, 10), ('d' * 64, 20)))

    def test_release_refusals(self):
        for text, suite in ((release('c' * 64, 10, suite='noble-updates'), 'noble'), (release('c' * 64, 10, codename='jammy'), 'noble'),
                            (release('c' * 64, 10).replace('Packages.xz', 'Packages.gz'), 'noble'),
                            (release('zz', 10), 'noble'), (release('c' * 64, 10) + ' ' + 'c' * 64 + ' 10 universe/binary-amd64/Packages.xz\n', 'noble')):
            with self.assertRaises(b3.Refuse):
                b3.parse_release(text, suite, 'universe')

    def test_exact_stanza_selected(self):
        txt = stanza() + '\n' + stanza(version='1.1.0-1') + '\n' + stanza(arch='arm64', filename='pool/universe/r/rust-b3sum/b3sum_1.2.0-1_arm64.deb')
        self.assertEqual(b3.select_stanza(txt, 'universe')['Version'], '1.2.0-1')

    def test_missing_or_duplicate_version_refuses(self):
        for txt in (stanza(version='1.1.0-1'), '', stanza() + '\n' + stanza()):
            with self.assertRaises(b3.Refuse) as c:
                b3.select_stanza(txt, 'universe')
            self.assertEqual(c.exception.code, 8)

    def test_filename_traversal_and_malformed_fields_refuse(self):
        for kw in (dict(filename='pool/universe/r/../../etc/b3sum_1.2.0-1_amd64.deb'), dict(filename='/pool/universe/r/x/b3sum_1.2.0-1_amd64.deb'),
                   dict(filename='pool/universe/r/rust-b3sum//b3sum_1.2.0-1_amd64.deb'), dict(filename='pool/main/r/rust-b3sum/b3sum_1.2.0-1_amd64.deb'),
                   dict(filename='pool/universe/r/rust-b3sum/other_1.2.0-1_amd64.deb'), dict(filename='http://x/b3sum_1.2.0-1_amd64.deb'),
                   dict(size='-1'), dict(size=str(64 << 20)), dict(sha='z' * 64)):
            with self.assertRaises(b3.Refuse, msg=str(kw)):
                b3.select_stanza(stanza(**kw), 'universe')


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
        b3.check_tool_outputs('b3sum 1.2.0\n', b3.BLAKE3_EMPTY + '\n')
        for v, k in (('b3sum 1.3.0', b3.BLAKE3_EMPTY), ('', b3.BLAKE3_EMPTY), ('b3sum 1.2.0', '0' * 64), ('b3sum 1.2.0', '')):
            with self.assertRaises(b3.Refuse):
                b3.check_tool_outputs(v, k)


class Inputs(unittest.TestCase):
    def args(self, **kw):
        d = dict(origin='https://archive.ubuntu.com/ubuntu', suite='noble', component='universe', keyring='/x', keyring_sha256='0' * 64,
                 allowed_primary_fpr=[FPR])
        d.update(kw); return argparse.Namespace(**d)

    def test_allowlists_and_pins(self):
        with tempfile.TemporaryDirectory() as t:
            k = os.path.join(t, 'keyring.gpg'); Path(k).write_bytes(b'keyring-bytes')
            good = self.args(keyring=k, keyring_sha256=b3.sha256b(b'keyring-bytes'))
            b3.common_checks(good)
            for bad in (dict(origin='http://archive.ubuntu.com/ubuntu'), dict(origin='https://mirror.example/ubuntu'), dict(suite='jammy'),
                        dict(component='multiverse'), dict(keyring_sha256='1' * 64), dict(keyring='keyring.gpg'),
                        dict(allowed_primary_fpr=[]), dict(allowed_primary_fpr=['XYZ'])):
                with self.assertRaises(b3.Refuse, msg=str(bad)):
                    b3.common_checks(argparse.Namespace(**{**vars(good), **bad}))
            os.symlink(k, os.path.join(t, 'link.gpg'))
            with self.assertRaises((b3.Refuse, OSError)):
                b3.common_checks(argparse.Namespace(**{**vars(good), 'keyring': os.path.join(t, 'link.gpg')}))


if __name__ == '__main__':
    unittest.main(verbosity=2)

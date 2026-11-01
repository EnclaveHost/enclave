import hashlib
import importlib.util
import io
from pathlib import Path
import struct
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('assemble_root', Path(__file__).with_name('assemble_root.py'))
root = importlib.util.module_from_spec(spec)
spec.loader.exec_module(root)


def fixture_elf():
    b = bytearray(512)
    ident = b'\x7fELF\x02\x01\x01' + bytes(9)
    struct.pack_into('<16sHHIQQQIHHHHHH', b, 0, ident, 3, 62, 1, 0, 64, 0, 0, 64, 56, 2, 0, 0, 0)
    struct.pack_into('<IIQQQQQQ', b, 64, 1, 5, 0, 0x400000, 0, 512, 512, 4096)
    struct.pack_into('<IIQQQQQQ', b, 120, 2, 4, 176, 0x4000b0, 0, 64, 64, 8)
    strings = b'\0libc.so.6\0'
    for i, pair in enumerate(((5, 0x400100), (10, len(strings)), (1, 1), (0, 0))):
        struct.pack_into('<qQ', b, 176 + 16 * i, *pair)
    b[256:256 + len(strings)] = strings
    return b


class ELFTests(unittest.TestCase):
    def test_needed_without_executing(self):
        b = fixture_elf()
        self.assertEqual(root.elf(io.BytesIO(b), len(b)), ([], ['libc.so.6']))

    def test_arch_and_geometry_refused(self):
        for off, fmt, value in ((18, '<H', 183), (54, '<H', 48), (56, '<H', 500), (32, '<Q', 10000), (96, '<Q', 10000)):
            with self.subTest(offset=off), self.assertRaises(ValueError):
                b = fixture_elf()
                struct.pack_into(fmt, b, off, value)
                root.elf(io.BytesIO(b), len(b))

    def test_search_override_refused(self):
        for tag in (15, 29, 0x7fffffff, 0x7ffffffd):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                b = fixture_elf()
                struct.pack_into('<q', b, 208, tag)
                root.elf(io.BytesIO(b), len(b))

    def test_unmapped_strings_and_no_terminator_refused(self):
        for off, value in ((184, 0x900000), (224, 1)):
            b = fixture_elf()
            struct.pack_into('<Q', b, off, value)
            with self.assertRaises(ValueError):
                root.elf(io.BytesIO(b), len(b))

    def test_dependency_path_refused(self):
        b = fixture_elf()
        b[257:266] = b'../bad.so'
        with self.assertRaises(ValueError):
            root.elf(io.BytesIO(b), len(b))


class AssemblyBoundaryTests(unittest.TestCase):
    def test_source_symlink_cannot_escape_sysroot(self):
        with tempfile.TemporaryDirectory() as temp:
            p = Path(temp)
            (p / 'root').mkdir()
            (p / 'outside').write_text('secret')
            (p / 'root/link').symlink_to('../outside')
            with self.assertRaises(ValueError):
                root.inside(p / 'root', 'link')

    def test_final_symlink_regular_reader_refuses(self):
        with tempfile.TemporaryDirectory() as temp:
            p = Path(temp)
            (p / 'input').write_text('bytes')
            (p / 'link').symlink_to('input')
            with self.assertRaises(OSError):
                root.open_file(p / 'link')

    def test_publication_never_overwrites(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'receipt'
            root.publish(path, b'first')
            with self.assertRaises(FileExistsError):
                root.publish(path, b'second')
            self.assertEqual(path.read_bytes(), b'first')

    def test_pinned_archive_cannot_be_substituted(self):
        with tempfile.TemporaryDirectory() as temp:
            p = Path(temp) / 'not-runtime.tar'
            p.write_bytes(b'not the reviewed archive')
            with root.open_file(p) as f, self.assertRaises(ValueError):
                root.checked_runtime(f)

    def test_member_pin_and_duplicate_refusal(self):
        with tarfile.open(fileobj=io.BytesIO(), mode='w', format=tarfile.USTAR_FORMAT) as tar:
            records = {}
            data = b'public'
            pin = hashlib.sha256(data).hexdigest()
            with self.assertRaises(ValueError):
                root.write_member(tar, 'usr/file', io.BytesIO(b'mutated'), 7, pin, 0o444, records)
            root.write_member(tar, 'usr/file', io.BytesIO(data), len(data), pin, 0o444, records)
            with self.assertRaises(ValueError):
                root.write_member(tar, 'usr/file', io.BytesIO(data), len(data), pin, 0o444, records)

    def test_deterministic_archive_and_readback_detect_corruption(self):
        data = b'public payload'
        pin = hashlib.sha256(data).hexdigest()
        outputs = []
        for _ in range(2):
            output, records = io.BytesIO(), {}
            with tarfile.open(fileobj=output, mode='w', format=tarfile.USTAR_FORMAT) as tar:
                root.write_member(tar, 'usr/file', io.BytesIO(data), len(data), pin, 0o444, records)
            outputs.append(output.getvalue())
        self.assertEqual(*outputs)
        with tempfile.TemporaryDirectory() as temp:
            p = Path(temp) / 'root.tar'
            p.write_bytes(outputs[0])
            root.readback(p, records, {})
            records['usr/file']['sha256'] = '0' * 64
            with self.assertRaises(ValueError):
                root.readback(p, records, {})

    def test_input_allowlist_excludes_secrets_and_customization(self):
        for path in ('etc/shadow', 'root/.ssh/id_rsa', 'usr/lib/python3.14/sitecustomize.py',
                     'usr/lib/python3.14/site-packages/code.py', 'usr/lib/python3.14/lib-dynload/_testcapi.so'):
            with self.subTest(path=path):
                self.assertFalse(root.allowed_input(path, '3.14'))
        self.assertTrue(root.allowed_input('usr/lib/python3.14/tomllib/__init__.py', '3.14'))

    def test_generated_root_has_no_credentials_or_storage_mapping(self):
        g = root.generated()
        self.assertNotIn('etc/enclave-rpc/jwt.hex', g)
        self.assertNotIn('etc/enclave-rpc-vm/disks.json', g)
        self.assertIn(b'rpcel:x:2101:2101:', g['etc/passwd'])
        self.assertIn(b'rpcprobe:x:2104:2104:', g['etc/passwd'])

    def test_unused_sqlite_and_test_extensions_not_packaged(self):
        for path in ('usr/lib/python3.14/sqlite3/__init__.py',
                     'usr/lib/python3.14/lib-dynload/_sqlite3.cpython-314.so',
                     'usr/lib/python3.14/lib-dynload/_xxtestfuzz.so'):
            with self.subTest(path=path):
                self.assertFalse(root.allowed_input(path, '3.14'))


if __name__ == '__main__':
    unittest.main()

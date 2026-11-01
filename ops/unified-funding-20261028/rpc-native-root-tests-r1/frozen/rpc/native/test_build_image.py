"""Archive boundary tests; positive filesystem/verity qualification is separate."""
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('build_image', Path(__file__).with_name('build_image.py'))
image = importlib.util.module_from_spec(spec)
spec.loader.exec_module(image)


def archive(rows):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode='w', format=tarfile.USTAR_FORMAT) as out:
        for name, kind, mode in rows:
            entry = tarfile.TarInfo(name)
            entry.mode = mode
            entry.type = kind
            if kind == tarfile.SYMTYPE:
                entry.linkname = '/etc/passwd'
            entry.size = 1 if kind == tarfile.REGTYPE else 0
            out.addfile(entry, io.BytesIO(b'x') if entry.size else None)
    data.seek(0)
    return data


REQUIRED = ['usr/bin/python3', 'usr/bin/findmnt', 'opt/enclave-rpc/chain_service.py',
            'opt/enclave-rpc/manifest.json', 'opt/enclave-rpc/bin/reth',
            'opt/enclave-rpc/bin/lighthouse', 'opt/enclave-rpc/bin/base',
            'etc/enclave-rpc/native-root']


class BoundaryTests(unittest.TestCase):
    def test_archive_shape_is_not_readiness(self):
        rows = [(p, tarfile.REGTYPE, 0o444) for p in REQUIRED]
        self.assertEqual(image.validate_archive(archive(rows)), (8, 8))

    def test_path_and_link_attacks_refused(self):
        for name, kind, mode in [('../bad', tarfile.REGTYPE, 0o444),
                                  ('/abs', tarfile.REGTYPE, 0o444),
                                  ('usr/./bad', tarfile.REGTYPE, 0o444),
                                  ('usr//bad', tarfile.REGTYPE, 0o444),
                                  ('usr/bad\\name', tarfile.REGTYPE, 0o444),
                                  ('usr/link', tarfile.SYMTYPE, 0o444),
                                  ('usr/device', tarfile.CHRTYPE, 0o444),
                                  ('usr/suid', tarfile.REGTYPE, 0o4555),
                                  ('usr/writable', tarfile.REGTYPE, 0o666)]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                image.validate_archive(archive([(name, kind, mode)]))

    def test_ancestor_file_in_both_orders_and_duplicates_refused(self):
        for paths in [('a', 'a/b'), ('a/b', 'a'), ('a', 'a')]:
            with self.subTest(paths=paths), self.assertRaises(ValueError):
                image.validate_archive(archive([(p, tarfile.REGTYPE, 0o444) for p in paths]))

    def test_incomplete_archive_refused(self):
        with self.assertRaises(ValueError):
            image.validate_archive(archive([('usr/bin/python3', tarfile.REGTYPE, 0o555)]))

    def test_digest_failure_creates_no_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'input').write_bytes(b'not a root')
            with self.assertRaises(ValueError):
                image.build(root / 'input', '1' * 64, root / 'output')
            self.assertFalse((root / 'output').exists())

    def test_input_symlink_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'file').write_bytes(b'content')
            (root / 'link').symlink_to('file')
            with self.assertRaises(OSError):
                image.regular(root / 'link', 128)

    def test_geometry_matches_fixed_three_level_tree(self):
        self.assertEqual(image.tree_bytes(262144), (2048 + 16 + 1) * 4096)


if __name__ == '__main__':
    unittest.main()

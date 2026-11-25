"""isolation/vmboot: the app's half of a whole-VM image is read strictly, and the disc wrapper carries the label
vm-init looks for with the payload untouched behind it."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT/'isolation/vmboot'/(name+'.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


boot, iso = load('build_boot'), load('wrap_iso')
sha = lambda b: hashlib.sha256(b).hexdigest()


def app_dir(d, **over):
    root, tree = b'\x5a' * 8192, b'\xa5' * 4096
    (d/'root.img').write_bytes(root)
    (d/'root.verity').write_bytes(tree)
    app = {'schema': 'enclave-vm-app/1', 'rootHash': 'ab'*32, 'rootBlocks': 2, 'rootSalt': 'cd'*32,
           'artifacts': {'root.img': {'bytes': len(root), 'sha256': sha(root)}, 'root.verity': {'bytes': len(tree), 'sha256': sha(tree)}},
           'kernelModules': ['uhid'], 'ports': ['tcp:47989'], **over}
    (d/'APP.json').write_text(json.dumps(app))
    return d


class AppImage(unittest.TestCase):
    def test_the_apps_command_line_comes_from_app_json_alone(self):
        with tempfile.TemporaryDirectory() as t:
            _, cmdline = boot.read_app(app_dir(Path(t)))
            self.assertEqual(cmdline, 'enclave.roothash=%s enclave.root=2:%s' % ('ab'*32, 'cd'*32))
        with tempfile.TemporaryDirectory() as t:
            _, cmdline = boot.read_app(app_dir(Path(t), models={'dataBlocks': 9, 'rootHash': 'ef'*32, 'salt': '01'*32}))
            self.assertTrue(cmdline.endswith(' enclave.models=9:%s:%s' % ('ef'*32, '01'*32)))

    def test_an_app_image_that_is_not_what_app_json_pins_is_refused(self):
        for over, change in (({}, 'root.img'), ({'rootBlocks': 3}, None), ({'rootHash': 'zz'*32}, None), ({'extra': 1}, None),
                             ({'kernelModules': ['../x']}, None), ({'models': {'dataBlocks': 9, 'rootHash': 'ef'*32}}, None)):
            with tempfile.TemporaryDirectory() as t:
                d = app_dir(Path(t), **over)
                if change:
                    (d/change).write_bytes(b'\x00' * 8192)
                with self.assertRaises((ValueError, KeyError), msg=str(over or change)):
                    boot.read_app(d)

    def test_only_built_platforms_have_a_module_set(self):
        self.assertEqual(set(boot.PLATFORM_MODULES), set(boot.PLATFORM_CMDLINE))
        self.assertIn('dm-verity', boot.PLATFORM_MODULES['sev-snp'])


class DiscWrapper(unittest.TestCase):
    def test_label_where_vm_init_reads_it_and_payload_at_65536(self):
        with tempfile.TemporaryDirectory() as t:
            src, dst = Path(t)/'p', Path(t)/'p.iso'
            payload = bytes(range(256)) * 32
            src.write_bytes(payload)
            out = iso.wrap('ROOT_DATA', src, dst, sha(payload))
            raw = dst.read_bytes()
            self.assertEqual(raw[16*2048:16*2048+7], b'\x01CD001\x01')
            self.assertEqual(raw[16*2048+40:16*2048+72].rstrip(b' '), b'ROOT_DATA')
            self.assertEqual(raw[65536:], payload)
            self.assertEqual((out['payloadOffset'], out['containerBytes'], out['containerSha256']), (65536, len(raw), sha(raw)))

    def test_refusals_leave_nothing_behind(self):
        with tempfile.TemporaryDirectory() as t:
            src, dst = Path(t)/'p', Path(t)/'p.iso'
            src.write_bytes(b'\x01' * 8192)
            for label, pin in (('root-data', sha(b'\x01'*8192)), ('ROOT_DATA', '00'*32), ('X'*33, sha(b'\x01'*8192))):
                with self.assertRaises(ValueError):
                    iso.wrap(label, src, dst, pin)
                self.assertFalse(dst.exists())
            src.write_bytes(b'\x01' * 100)
            with self.assertRaises(ValueError):
                iso.wrap('ROOT_DATA', src, dst, sha(b'\x01'*100))


if __name__ == '__main__':
    unittest.main()

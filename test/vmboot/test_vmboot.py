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


boot, iso, version = load('build_boot'), load('wrap_iso'), load('version_config')
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


class ShieldWrapper(unittest.TestCase):
    def test_the_boot_recipe_is_the_non_debug_one_with_this_images_command_line(self):
        m = boot.igvm_manifest(7, 'console=ttyS0 enclave.roothash=' + 'ab'*32)
        c = m['guest_configs'][0]
        self.assertEqual((c['guest_svn'], c['max_vtl'], c['isolation_type']), (7, 2, {'vbs': {'enable_debug': False}}))
        self.assertEqual(c['image']['openhcl']['linux'], {'use_initrd': True, 'command_line': 'console=ttyS0 enclave.roothash=' + 'ab'*32})
        self.assertIs(c['image']['openhcl']['static_command_line'], True)
        for svn, line in ((0, 'x'), (70000, 'x'), (True, 'x'), (1, ''), (1, 'a"b'), (1, 'a\nb'), (1, 'a\\b')):
            with self.assertRaises(ValueError, msg=repr((svn, line))):
                boot.igvm_manifest(svn, line)

    def test_only_the_reviewed_paravisor_is_wrapped(self):
        with tempfile.TemporaryDirectory() as t:
            d = Path(t)
            app_dir(d)
            for name in ('k', 'r', 'x'):
                (d/name).write_bytes(name.encode())
            pin = lambda n: {'path': str(d/n), 'sha256': sha(n.encode())}
            spec = {'out': str(d/'out'), 'app': str(d), 'platform': 'shield', 'kernel': {'vmlinuz': str(d/'k'), 'sha256': sha(b'k')},
                    'kernelRoot': {'image': str(d/'r'), 'sha256': sha(b'r'), 'release': '6.8.0-147-generic'},
                    'shield': {n: pin('x') for n in ('igvmfilegen', 'openhclBoot', 'underhillKernel', 'underhillInitrd', 'tpmModule')} | {'guestSvn': 1}}
            (d/'spec.json').write_text(json.dumps(spec))
            with self.assertRaisesRegex(ValueError, 'unreviewed OpenHCL input'):
                boot.main(d/'spec.json')
            self.assertFalse((d/'out').exists())
            spec.pop('shield')
            (d/'spec.json').write_text(json.dumps(spec))
            with self.assertRaisesRegex(ValueError, 'unsupported build specification'):
                boot.main(d/'spec.json')

    def test_a_kernel_image_without_an_elf_kernel_is_refused(self):
        with tempfile.TemporaryDirectory() as t:
            (Path(t)/'k').write_bytes(b'MZ' + b'\x00' * 4096)
            with self.assertRaises(ValueError):
                boot.elf_kernel(Path(t)/'k', Path(t)/'out')
            self.assertFalse((Path(t)/'out').exists())


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


class VersionConfig(unittest.TestCase):
    """One root image, a launch identity per platform."""
    app = {'rootHash': 'ab'*32}
    snp = {'schema': 'enclave-vm-image/1', 'platform': 'sev-snp', 'rootHash': 'ab'*32, 'app': app, 'appJsonSha256': 'cd'*32,
           'cmdline': 'console=ttyS0 panic=-1 enclave.roothash='+'ab'*32}
    shield = {'schema': 'enclave-vm-image/1', 'platform': 'shield', 'rootHash': 'ab'*32, 'app': app, 'appJsonSha256': 'cd'*32,
              'cmdline': 'console=ttyS0 loglevel=3 panic=-1 enclave.roothash='+'ab'*32,
              'launchIdentity': {'vbsBootDigest': 'ef'*32, 'guestSvn': 4}}
    given = dict(snp={'8': '11'*48, '16': '22'*48}, ovmf_sha256='33'*32, vcpu_type='EPYC-v4')

    def test_both_platforms_share_the_root(self):
        c = version.config([self.snp, self.shield], **self.given)
        self.assertEqual(c, {'runtime': 'sev-snp-vm',
                             'image': {'rootHash': 'ab'*32, 'ovmfSha256': '33'*32, 'cmdlineSha256': sha(self.snp['cmdline'].encode())},
                             'snp': {'measurements': {'8': '11'*48, '16': '22'*48}, 'vcpuType': 'EPYC-v4'},
                             'shield': {'launch': [{'bootDigest': 'ef'*32, 'guestSvn': 4}]}})
        self.assertEqual(version.config([self.shield, self.snp], **self.given), c)

    def test_one_platform_alone(self):
        self.assertEqual(version.config([self.shield]), {'runtime': 'sev-snp-vm', 'image': {'rootHash': 'ab'*32},
                                                         'shield': {'launch': [{'bootDigest': 'ef'*32, 'guestSvn': 4}]}})
        self.assertNotIn('shield', version.config([self.snp], **self.given))

    def test_refusals(self):
        other_root = {**self.shield, 'rootHash': '99'*32, 'app': {'rootHash': '99'*32}}
        other_app = {**self.shield, 'appJsonSha256': '98'*32}
        for images, kw in (([self.snp, other_root], self.given), ([self.snp, other_app], self.given),
                           ([self.snp, self.snp], self.given), ([], {}), ([self.snp], {}),
                           ([self.snp], {**self.given, 'snp': {'8': '11'*48, '16': '11'*48}}),
                           ([self.snp], {**self.given, 'snp': {'08': '11'*48}}),
                           ([self.snp], {**self.given, 'snp': {'8': '11'*32}}),
                           ([self.shield], self.given),
                           ([{**self.shield, 'launchIdentity': {'vbsBootDigest': 'ef'*32}}], {}),
                           ([{**self.shield, 'launchIdentity': {'vbsBootDigest': 'EF'*32, 'guestSvn': 1}}], {}),
                           ([{**self.shield, 'platform': 'tdx'}], {}),
                           ([{**self.shield, 'app': {'rootHash': '97'*32}}], {})):
            with self.assertRaises(ValueError, msg=repr((images, kw))[:120]):
                version.config(images, **kw)


if __name__ == '__main__':
    unittest.main()

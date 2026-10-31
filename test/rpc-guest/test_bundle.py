import configparser
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2] / 'rpc/guest'
spec = importlib.util.spec_from_file_location('bundle', ROOT / 'prepare_bundle.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.pins = {}
        for name in b.BINARY_PINS:
            raw = ('inert-' + name).encode()
            (self.bin / name).write_bytes(raw)
            self.pins[name] = hashlib.sha256(raw).hexdigest()
        self.disks = {'disks': [
            {'role': role, 'mount': mount, 'uuid': str(__import__('uuid').uuid4())}
            for role, mount in b.MOUNTS.items()]}
        self.manifest = {'format': 'enclave-rpc-production-bootstrap/v1',
                         'binaries': self.pins, 'mounts': b.MOUNTS,
                         'servingProduction': False}
        self.chain = {'checkpoint': {}, 'txForwarding': {},
                      'baseBootstrap': {'coverageVerified': False}, 'baseRetention': {}}

    def prepare(self):
        for name, value in [('manifest', self.manifest), ('chain', self.chain), ('disks', self.disks)]:
            (self.root / name).write_text(json.dumps(value))
        with patch.object(b, 'BINARY_PINS', self.pins):
            return b.prepare(self.bin, self.root/'manifest', self.root/'chain', self.root/'disks', self.root/'output')

    def test_complete_archive_has_exact_bytes_and_no_secret_or_autostart(self):
        result = self.prepare()
        b.verify_archive(self.root/'output/runtime.tar', result['members'])
        self.assertEqual(result['wholeStackBudgetBytes'], 21474836480)
        self.assertFalse(result['rpcReady'])
        self.assertFalse(result['baseCoverageApproved'])
        self.assertFalse(any('jwt' in n or 'wants/' in n for n in result['members']))
        with tarfile.open(self.root/'output/runtime.tar') as tar:
            self.assertEqual(tar.extractfile('opt/enclave-rpc/bin/reth').read(), b'inert-reth')

    def test_wrong_binary_is_refused_and_partial_attempt_retained(self):
        (self.bin/'reth').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'digest mismatch'):
            self.prepare()
        self.assertTrue((self.root/'output/runtime.tar').exists())
        self.assertFalse((self.root/'output/RESULT.json').exists())
        with self.assertRaises(FileExistsError):
            self.prepare()

    def test_binary_symlink_refused(self):
        (self.bin/'reth').unlink()
        (self.bin/'reth').symlink_to(self.bin/'base')
        with self.assertRaises(OSError):
            self.prepare()

    def test_configuration_fifo_refused_without_waiting_for_writer(self):
        path = self.root/'fifo'
        os.mkfifo(path)
        with self.assertRaisesRegex(ValueError, 'regular'):
            b.public_config(path)

    def test_configuration_symlink_refused(self):
        path = self.root/'config-link'
        path.symlink_to(self.bin/'base')
        with self.assertRaises(OSError):
            b.public_config(path)

    def test_wrong_mount_and_duplicate_volume_refused(self):
        self.disks['disks'][0]['mount'] = '/'
        with self.assertRaisesRegex(ValueError, 'role/mount'):
            self.prepare()
        self.disks['disks'][0]['mount'] = b.MOUNTS[self.disks['disks'][0]['role']]
        self.disks['disks'][1]['uuid'] = self.disks['disks'][0]['uuid']
        with self.assertRaisesRegex(ValueError, 'Distinct'):
            self.prepare()

    def test_missing_base_volume_refused(self):
        self.disks['disks'].pop()
        with self.assertRaisesRegex(ValueError, 'Both'):
            self.prepare()

    def test_unknown_client_pin_refused(self):
        self.manifest['binaries'] = dict(self.pins, base='0'*64)
        with self.assertRaisesRegex(ValueError, 'reviewed'):
            self.prepare()

    def test_archive_tamper_is_detected(self):
        result = self.prepare()
        path = self.root/'output/runtime.tar'
        with tarfile.open(path) as tar:
            offset = tar.getmember('opt/enclave-rpc/bin/base').offset_data
        with path.open('r+b') as out:
            out.seek(offset)
            out.write(b'X')
        with self.assertRaisesRegex(ValueError, 'bytes differ'):
            b.verify_archive(path, result['members'])

    def test_units_bound_combined_clients_and_do_not_retry(self):
        total = 0
        for side, cap in [('el', 5), ('cl', 7), ('base', 5)]:
            unit = configparser.ConfigParser(interpolation=None)
            unit.read(ROOT/'units'/('enclave-rpc-'+side+'.service'))
            service = unit['Service']
            self.assertEqual(service['MemoryMax'], str(cap)+'G')
            self.assertEqual(service['MemorySwapMax'], '0')
            self.assertEqual(service['Slice'], 'enclave-rpc-clients.slice')
            self.assertEqual(service['Restart'], 'no')
            self.assertIn('BindsTo', unit['Unit'])
            self.assertNotIn('Install', unit)
            total += cap
        self.assertEqual(total, 17)
        unit = configparser.ConfigParser()
        unit.read(ROOT/'units/enclave-rpc-clients.slice')
        self.assertEqual(unit['Slice']['MemoryMax'], '17G')
        self.assertLess((total+2+1)*1024**3, 32000000000)


if __name__ == '__main__':
    unittest.main()

"""Owner clock/export composition; no services, provider calls or real keys."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'rpc/server'))
import prepare_export as prepare
import guarded_export as guard

clock = prepare.clock
p = clock.protocol


class Composition(unittest.TestCase):
    def setUp(self):
        base = Path(os.environ['RPC_TEST_ROOT'])
        clock.directory(base)
        self.temp = tempfile.TemporaryDirectory(dir=base)
        self.root = Path(self.temp.name)
        self.wall = time.time_ns()
        self.mono = time.monotonic_ns()
        self.patches = [mock.patch.object(time, 'time_ns', lambda: self.wall),
                        mock.patch.object(time, 'monotonic_ns', lambda: self.mono),
                        mock.patch.object(time, 'monotonic', lambda: self.mono / 1e9)]
        for patch in self.patches:
            patch.start()
        self.attempt = 'a' * 32
        self.vm = 'b' * 32
        self.instance = 'rpc-owned-' + self.attempt
        self.windows = 'c' * 32
        self.started = clock.begin(self.root, self.attempt, self.instance, self.vm)
        self.initial = p.decode(clock.read_pinned(self.started))

    def tearDown(self):
        for patch in reversed(self.patches):
            patch.stop()
        self.temp.cleanup()

    def advance(self, ns):
        self.wall += ns
        self.mono += ns

    def file(self, name, value):
        raw = value if isinstance(value, bytes) else clock.encode(value)
        return clock.write_new(self.root / name, raw)

    def sample(self, **changes):
        row = {'schema': 'owned-rpc-windows-clock/1', 'attempt': self.attempt,
               'vmAttempt': self.vm, 'windowsBoot': self.windows, 'monotonicMilliseconds': 1000000}
        row.update(changes)
        return self.file('sample.json', row)

    def completed(self):
        sample = self.sample()
        self.advance(1_000_000_001)
        return clock.finish(self.started, sample)

    def test_delay_is_consumed_and_windows_origin_is_conservative(self):
        bound = self.completed()
        row = clock.validate(bound)
        self.assertEqual(row['createdUtcNs'], self.initial['createdUtcNs'])
        self.assertEqual(row['deadlineUtcNs'] - row['createdUtcNs'], clock.WINDOW)
        self.assertEqual(row['windowsOriginMilliseconds'], 998998)
        self.assertEqual(row['windowsDeadlineMilliseconds'], 1898998)
        self.assertLess(clock.remaining(bound), 899)

    def test_begin_cannot_replace_original(self):
        with self.assertRaises(FileExistsError):
            clock.begin(self.root, self.attempt, self.instance, self.vm)

    def test_finish_is_one_shot(self):
        sample = self.sample()
        clock.finish(self.started, sample)
        with self.assertRaises(FileExistsError):
            clock.finish(self.started, sample)

    def test_invalid_sample_consumes_finish_without_clock(self):
        sample = self.sample(vmAttempt='d' * 32)
        with self.assertRaises(ValueError):
            clock.finish(self.started, sample)
        self.assertTrue((Path(self.started['path']).parent / 'finish.intent').is_file())
        self.assertFalse((Path(self.started['path']).parent / 'clock.json').exists())
        with self.assertRaises(FileExistsError):
            clock.finish(self.started, sample)

    def test_late_handshake_refused(self):
        sample = self.sample()
        self.advance(10_000_000_001)
        with self.assertRaises(ValueError):
            clock.finish(self.started, sample)

    def test_clock_jump_refused(self):
        sample = self.sample()
        self.wall += 2_000_000_001
        with self.assertRaises(ValueError):
            clock.finish(self.started, sample)

    def test_wrong_local_boot_refused(self):
        sample = self.sample()
        with mock.patch.object(clock, 'snapshot', return_value=(self.wall, self.mono, 'd' * 8 + '-1111-1111-1111-' + 'e' * 12)):
            with self.assertRaises(ValueError):
                clock.finish(self.started, sample)

    def test_invalid_integer_types_and_bounds(self):
        row = p.decode(clock.read_pinned(self.sample()))
        for value in (True, -1, 1.5, '100', clock.MAX_INT + 1, 0, clock.MAX_INT):
            with self.subTest(value=value), self.assertRaises(ValueError):
                clock.compose(self.initial, {**row, 'monotonicMilliseconds': value}, 1000000, '1' * 64, '2' * 64)

    def test_duplicate_json_field_refused(self):
        raw = clock.read_pinned(self.sample()).rstrip()
        raw = raw[:-1] + b',"attempt":"' + self.attempt.encode() + b'"}'
        bad = self.file('duplicate.json', raw)
        with self.assertRaises(ValueError):
            clock.finish(self.started, bad)

    def test_symlink_and_hardlink_refused(self):
        sample = self.sample()
        link = self.root / 'linked.json'
        link.symlink_to(sample['path'])
        with self.assertRaises(OSError):
            clock.read_pinned({'path': str(link), 'sha256': sample['sha256']})
        link.unlink()
        os.link(sample['path'], link)
        with self.assertRaises(ValueError):
            clock.read_pinned(sample)

    def test_publicly_readable_input_refused(self):
        sample = self.sample()
        Path(sample['path']).chmod(0o644)
        with self.assertRaises(ValueError):
            clock.finish(self.started, sample)

    def test_tampered_completed_clock_refused_even_with_new_outer_digest(self):
        bound = self.completed()
        raw = p.decode(clock.read_pinned(bound))
        raw['deadlineUtcNs'] += 1
        Path(bound['path']).write_bytes(clock.encode(raw))
        altered = {'path': bound['path'], 'sha256': p.sha(clock.encode(raw))}
        with self.assertRaises(ValueError):
            clock.validate(altered)

    def test_monotonic_expiry_cannot_be_extended_by_wall_offset(self):
        bound = self.completed()
        self.advance(899_000_000_000)
        self.wall -= 1_000_000_000
        with self.assertRaises(ValueError):
            clock.validate(bound)

    def export_config(self):
        bound = self.completed()
        roles = {}
        credentials = {'schema': 'owned-rpc-credentials/1', 'attempt': self.attempt, 'instance': self.instance, 'roles': {}}
        for index, role in enumerate(('l1', 'base')):
            base = self.root / role
            base.mkdir(mode=0o700)
            for kind in ('server', 'client', 'cow'):
                (base / kind).mkdir(mode=0o700)
            public = {'tlsName': 'rpc-storage-' + self.attempt + '-' + role,
                      'clientDN': 'CN=rpc-client-' + self.attempt + '-' + role}
            for kind in ('server', 'client'):
                for name, data in [('ca-cert.pem', (role + ' public CA fixture').encode()),
                                   (kind + '-cert.pem', (role + kind + ' public certificate fixture').encode()),
                                   (kind + '-key.pem', b'inert fixture, not a private key')]:
                    clock.write_new(base / kind / name, data)
                    if name == 'ca-cert.pem':
                        public['caSha256'] = p.sha(data)
                    elif name == kind + '-cert.pem':
                        public[kind + 'CertificateSha256'] = p.sha(data)
            original = base / 'original.fixture'
            clock.write_new(original, b'inert disk fixture')
            credentials['roles'][role] = public
            roles[role] = {'parent': str(base / 'cow'), 'originals': [[str(original), prepare.volume.metadata(original)]],
                           'tls': str(base / 'server'), 'clientTls': str(base / 'client'),
                           'host': '192.0.2.1', 'port': 10900 + index}
        client = self.file('control-client.fixture', b'inert client')
        key = self.file('control-key.fixture', b'inert test key')
        resource = self.file('resource.json', {'url': 'http://127.0.0.1:8095', 'controlClient': client['path'],
                                              'controlClientSha256': client['sha256'], 'keyFile': key['path']})
        paths = [ROOT / 'rpc/server' / n for n in ('guarded_export.py', 'volume_export.py', 'observe_resources.mjs')]
        paths += [ROOT / 'rpc' / n for n in ('startup_clock.py', 'storage_protocol.py')]
        paths += [Path(resource['path']), Path('/usr/bin/node'), *map(Path, prepare.volume.TOOLS)]
        pins = {str(path): prepare.digest(path) for path in paths}
        self.assertTrue(all(pins[k] == v for k, v in prepare.volume.TOOLS.items()), 'Fixture needs reviewed installed QEMU tools')
        (self.root / 'state').mkdir(mode=0o700)
        (self.root / 'output').mkdir(mode=0o700)
        return {'clock': bound, 'credentialReceipt': self.file('credentials.json', credentials),
                'resourceConfig': resource, 'runtimePins': pins, 'roles': roles,
                'stateParent': str(self.root / 'state'), 'output': str(self.root / 'output' / self.attempt),
                'floorMiB': 27648, 'reserveMiB': 512}

    def test_real_preparer_protocol_and_consumer_bind_same_original_clock(self):
        config = self.export_config()
        self.advance(2_000_000_000)
        result = prepare.prepare(config)
        contract = p.decode(clock.read_pinned(result['contract']))
        self.assertFalse(result['exportStarted'])
        self.assertEqual(contract['createdUtcNs'], self.initial['createdUtcNs'])
        self.assertEqual(set(contract['roles']), {'l1', 'base'})
        negotiated = {role: {'export': 'rpc-' + self.attempt + '-' + role, 'bytes': p.BYTES,
                             'authenticated': True, 'flush': True, 'fua': True} for role in ('l1', 'base')}
        ready = p.make_ready(contract, result['contract']['sha256'], negotiated, 'd' * 32, self.wall)
        attachment = p.compose(clock.read_pinned(result['contract']), clock.encode(ready),
                               clock.read_pinned(config['credentialReceipt']), self.initial['bootId'], self.wall)
        self.assertEqual(attachment['deadlineUtcNs'], self.initial['createdUtcNs'] + clock.WINDOW)
        self.assertEqual(guard.startup_deadline(contract), (self.initial['originMonotonicNs'] + clock.WINDOW) / 1e9)
        self.assertEqual(stat.S_IMODE(Path(result['contract']['path']).stat().st_mode), 0o600)

    def test_consumer_does_not_gain_allowed_wall_clock_offset(self):
        config = self.export_config()
        result = prepare.prepare(config)
        contract = p.decode(clock.read_pinned(result['contract']))
        self.advance(2_000_000_000)
        self.wall -= 1_000_000_000
        deadline = guard.startup_deadline(contract)
        self.assertEqual(deadline, (self.initial['originMonotonicNs'] + clock.WINDOW) / 1e9)

    def test_consumer_refuses_changed_window_or_clock_pin(self):
        result = prepare.prepare(self.export_config())
        contract = p.decode(clock.read_pinned(result['contract']))
        for field in ('attempt', 'instance', 'bootId', 'createdUtcNs', 'deadlineUtcNs'):
            altered = copy.deepcopy(contract)
            altered[field] = altered[field] + 1 if isinstance(altered[field], int) else 'changed'
            with self.subTest(field=field), self.assertRaises(ValueError):
                guard.startup_deadline(altered)
        contract['sourcePins'][str(ROOT / 'rpc/startup_clock.py')] = '0' * 64
        with self.assertRaises(ValueError):
            guard.startup_deadline(contract)

    def test_consumer_refuses_unbound_legacy_contract(self):
        result = prepare.prepare(self.export_config())
        contract = p.decode(clock.read_pinned(result['contract']))
        del contract['startupClock']
        with self.assertRaises(ValueError):
            guard.startup_deadline(contract)

    def test_export_preparation_refuses_replay(self):
        config = self.export_config()
        prepare.prepare(config)
        with self.assertRaises(FileExistsError):
            prepare.prepare(config)

    def test_export_source_pin_refusal(self):
        config = self.export_config()
        config['runtimePins'][str(ROOT / 'rpc/server/guarded_export.py')] = '0' * 64
        with self.assertRaises(ValueError):
            prepare.prepare(config)

    def test_export_credential_mismatch(self):
        config = self.export_config()
        raw = p.decode(clock.read_pinned(config['credentialReceipt']))
        raw['attempt'] = 'e' * 32
        config['credentialReceipt'] = self.file('wrong-credentials.json', raw)
        with self.assertRaises(ValueError):
            prepare.prepare(config)

    def test_original_changed(self):
        config = self.export_config()
        Path(config['roles']['l1']['originals'][0][0]).write_bytes(b'changed')
        with self.assertRaises(ValueError):
            prepare.prepare(config)

    def test_duplicate_port_refused(self):
        config = self.export_config()
        config['roles']['base']['port'] = config['roles']['l1']['port']
        with self.assertRaises(ValueError):
            prepare.prepare(config)

    def test_floor_and_reserve_cannot_weaken(self):
        config = self.export_config()
        for field, value in [('floorMiB', 27647), ('reserveMiB', 511), ('reserveMiB', True)]:
            altered = copy.deepcopy(config)
            altered[field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                prepare.prepare(altered)

    def test_private_key_symlink_refused_without_read(self):
        config = self.export_config()
        key = Path(config['roles']['l1']['tls']) / 'server-key.pem'
        key.unlink()
        key.symlink_to(self.root / 'control-key.fixture')
        with self.assertRaises(ValueError):
            prepare.prepare(config)

    def test_consumed_export_path_refused(self):
        config = self.export_config()
        (Path(config['roles']['l1']['parent']) / (self.attempt + '-l1')).mkdir(mode=0o700)
        with self.assertRaises(ValueError):
            prepare.prepare(config)

    def test_no_private_keys_opened_or_services_spawned(self):
        config = self.export_config()
        opened = []
        original_open = os.open
        original_path_open = Path.open
        def observed(path, *args, **kwargs):
            opened.append(str(path))
            return original_open(path, *args, **kwargs)
        def path_open(path, *args, **kwargs):
            opened.append(str(path))
            return original_path_open(path, *args, **kwargs)
        with mock.patch.object(os, 'open', side_effect=observed), mock.patch.object(Path, 'open', path_open), mock.patch('subprocess.Popen', side_effect=AssertionError('No service execution')):
            prepare.prepare(config)
        self.assertFalse(any(name.endswith('-key.pem') for name in opened))


if __name__ == '__main__':
    unittest.main(verbosity=2)

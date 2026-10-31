"""Real protected one-shot files; transport and Windows observation are fixtures."""
import base64
import hashlib
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'rpc'))
import sample_windows_clock as sample

c = sample.clock


class Transport(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ['RPC_TEST_ROOT'])
        self.root = Path(self.temp.name)
        self.wall, self.mono, self.boot = c.snapshot()
        self.clock = mock.patch.object(c, 'snapshot', lambda: (self.wall, self.mono, self.boot))
        self.clock.start()
        self.begin = c.begin(self.root, 'a'*32, 'rpc-owned-'+'a'*32, 'b'*32)
        self.journal = Path(self.begin['path']).parent
        self.identity = c.write_new(self.root/'identity', b'not-a-private-key-test-fixture\n')
        host = b'\0\0\0\x0bssh-ed25519\0\0\0\x20'+bytes(range(32))
        known = b'windows-clock ssh-ed25519 '+base64.b64encode(host)+b'\n'
        self.config = {'begin': self.begin,
            'target': {'host': '192.0.2.5', 'port': 22, 'user': 'testadmin', 'identityFile': self.identity['path']},
            'knownHosts': c.write_new(self.root/'known', known), 'hostAlias': 'windows-clock',
            'sshSha256': hashlib.sha256(Path('/usr/bin/ssh').read_bytes()).hexdigest(),
            'samplerPath': r'C:\EnclaveRpcClock-test\clock-sample.exe',
            'samplerSha256': 'd'*64, 'windowsBoot': 'c'*32}
        self.value = {'schema': 'owned-rpc-windows-clock/1', 'attempt': 'a'*32,
            'vmAttempt': 'b'*32, 'windowsBoot': 'c'*32, 'monotonicMilliseconds': 1000000}
        self.exchange = mock.patch.object(sample.delivery, 'exchange', side_effect=self.reply)
        self.call = self.exchange.start()

    def tearDown(self):
        self.exchange.stop()
        self.clock.stop()
        self.temp.cleanup()

    def reply(self, argv, raw, seconds):
        self.assertTrue((self.journal/'sampling.intent').is_file())
        self.assertEqual(raw, b'')
        self.assertLessEqual(seconds, 8)
        self.wall += 2_000_000_000
        self.mono += 2_000_000_000
        return c.encode(self.value)

    def assert_consumed(self):
        with self.assertRaises(FileExistsError):
            sample.sample(self.config)
        self.assertEqual(self.call.call_count, 1)
        self.assertFalse((self.journal/'clock.json').exists())

    def test_authenticated_command_and_original_clock(self):
        start = c.protocol.decode(c.read_pinned(self.begin))
        result = c.validate(sample.sample(self.config))
        self.assertEqual(result['createdUtcNs'], start['createdUtcNs'])
        self.assertEqual(result['windowsOriginMilliseconds'], 997999)
        argv = self.call.call_args.args[0]
        self.assertIn('-oStrictHostKeyChecking=yes', argv)
        self.assertIn('-oIdentitiesOnly=yes', argv)
        self.assertIn('-oGlobalKnownHostsFile=/dev/null', argv)
        self.assertEqual(argv[-1], self.config['samplerPath']+' '+'a'*32+' '+'b'*32+' '+'d'*64)
        with self.assertRaises(FileExistsError):sample.sample(self.config)
        self.assertEqual(self.call.call_count, 1)

    def test_transport_loss_stays_consumed(self):
        self.call.side_effect = TimeoutError('ambiguous remote outcome')
        with self.assertRaises(TimeoutError):sample.sample(self.config)
        self.assert_consumed()

    def test_wrong_boot_stays_consumed(self):
        self.value['windowsBoot'] = 'e'*32
        with self.assertRaises(ValueError):sample.sample(self.config)
        self.assert_consumed()

    def test_wrong_attempt_stays_consumed(self):
        self.value['attempt'] = 'e'*32
        with self.assertRaises(ValueError):sample.sample(self.config)
        self.assert_consumed()

    def test_late_reply_not_a_new_clock(self):
        def late(*args):
            self.wall += 11_000_000_000
            self.mono += 11_000_000_000
            return c.encode(self.value)
        self.call.side_effect = late
        with self.assertRaises(ValueError):sample.sample(self.config)
        self.assertTrue((self.journal/'sampling.intent').exists())
        self.assertFalse((self.journal/'clock.json').exists())

    def test_invalid_commands_never_submit(self):
        for path in ['C:\\x\\clock-sample.exe & calc', '\\\\host\\clock-sample.exe',
                     'C:\\x\\..\\clock-sample.exe', 'C:\\x\\clock-sample.exe:stream']:
            self.config['samplerPath'] = path
            with self.assertRaises(ValueError):sample.sample(self.config)
        self.call.assert_not_called()

    def test_wrong_ssh_pin_never_submits(self):
        self.config['sshSha256'] = '0'*64
        with self.assertRaises(ValueError):sample.sample(self.config)
        self.call.assert_not_called()

    def test_host_key_alias_mismatch_never_submits(self):
        self.config['hostAlias'] = 'other'
        with self.assertRaises(ValueError):sample.sample(self.config)
        self.call.assert_not_called()

    def test_identity_bytes_are_not_read(self):
        original = os.open
        def guard(path, *args, **kwargs):
            if str(path) == self.identity['path']:raise AssertionError('Private identity opened')
            return original(path, *args, **kwargs)
        original_read = Path.open
        def path_guard(path, *args, **kwargs):
            if str(path) == self.identity['path']:raise AssertionError('Private identity opened')
            return original_read(path, *args, **kwargs)
        with mock.patch.object(os, 'open', guard), mock.patch.object(Path, 'open', path_guard):
            c.validate(sample.sample(self.config))

    def test_malformed_reply_stays_consumed(self):
        self.call.return_value = b'not JSON'
        self.call.side_effect = None
        with self.assertRaises(ValueError):sample.sample(self.config)
        self.assert_consumed()


if __name__ == '__main__':unittest.main(verbosity=2)

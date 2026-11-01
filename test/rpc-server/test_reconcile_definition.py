"""Real private journals; SSH, Windows clocks and provider results are fixtures."""
import copy
from pathlib import Path
import sys
from unittest import mock
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'rpc'))
import reconcile_definition as r
from test_windows_transition import Transition

c = r.c


class Reconciliation(Transition):
    def setUp(self):
        self.reader = False
        super().setUp()
        self.advance('cut-seed')
        self.advance('define')
        boot = self.config('boot')
        prior = self.journal / 'windows-define' / 'request.json'
        self.cfg = {'clock': self.clock, 'definitionRequest': {'path': str(prior), 'sha256': c.protocol.sha(c.read(prior))},
                    'transport': self.transport, 'nonce': '8'*32, 'binaries': boot['binaries'],
                    'observation': boot['observation'], 'input': boot['input']}
        self.wall += c.WINDOW
        self.mono += c.WINDOW
        self.reader = True
        self.sample_tick = self.original['windowsDeadlineMilliseconds'] + 1000
        self.state = 'response-lost-held'
        self.reader_mutate = lambda row: row
        self.call.reset_mock()

    def exchange(self, argv, raw, seconds):
        if not self.reader:
            return super().exchange(argv, raw, seconds)
        folder = self.journal / 'windows-definition-reconcile'
        self.assertEqual(raw, b'')
        self.assertIn('-oStrictHostKeyChecking=yes', argv)
        if 'clock-sample.exe' in argv[-1]:
            self.assertTrue((folder / 'sample.intent').is_file())
            return c.encode(self.reader_mutate({'schema': 'owned-rpc-windows-clock/1',
                'attempt': self.cfg['nonce'], 'vmAttempt': self.original['vmAttempt'],
                'windowsBoot': self.original['windowsBoot'], 'monotonicMilliseconds': self.sample_tick}))
        intent = c.protocol.decode(c.read(folder / 'submit.intent'))
        self.assertEqual(intent['command'], argv[-1])
        self.assertEqual(argv[-1].split()[5], 'definition-reconcile')
        self.assertEqual(intent['deadline'] - intent['origin'], 30000)
        self.assertEqual(seconds, 32)
        settled = self.state in ('defined-owned-off', 'definition-failed-held')
        return c.encode(self.reader_mutate({'schema': 'owned-rpc-target-definition/1', 'passed': True,
            'operation': 'definition-reconcile', 'origin': intent['origin'], 'deadline': intent['deadline'],
            'root': 'C:\\EnclaveRpcDefinition-' + self.cfg['nonce'] + '\\' + self.cfg['nonce'],
            'plan': self.cfg['input']['binding']['sha256'], 'failures': [], 'startAuthorized': False,
            'reservationMayRelease': False, 'result': {'state': self.state,
                'guid': self.guid if self.state == 'defined-owned-off' else '',
                'definitionSettled': settled, 'startAuthorized': False}}))

    def run_reader(self):
        return c.protocol.decode(c.read_pinned(r.execute(self.cfg)))

    def test_reader_lost_response_stays_held_and_clock_unchanged(self):
        original = c.read_pinned(self.clock)
        # A definition RESULT is unnecessary; a lost transport still has intent.
        (self.journal / 'windows-define' / 'RESULT.json').unlink()
        row = self.run_reader()
        self.assertTrue(row['observationCompleted'])
        for key in ('definitionSettled', 'newStartupAuthorized', 'rpcReady', 'remoteDeathProven', 'reservationMayRelease'):
            self.assertIs(row[key], False)
        self.assertEqual(c.read_pinned(self.clock), original)
        self.assertEqual(self.call.call_count, 2)

    def test_reader_success_is_off_only(self):
        self.state = 'defined-owned-off'
        row = self.run_reader()
        self.assertTrue(row['definitionSettled'])
        self.assertFalse(row['newStartupAuthorized'])

    def test_reader_failed_job_remains_held(self):
        self.state = 'definition-failed-held'
        row = self.run_reader()
        self.assertTrue(row['definitionSettled'])
        self.assertFalse(row['reservationMayRelease'])

    def test_reader_refuses_replay_after_lost_transport(self):
        old = self.exchange
        def fail(argv, raw, seconds):
            if 'clock-sample.exe' in argv[-1]: return old(argv, raw, seconds)
            raise r.w.delivery.ExchangeFailure('timeout', None, b'partial', b'fixture')
        self.call.side_effect = fail
        with self.assertRaises(r.w.delivery.ExchangeFailure): r.execute(self.cfg)
        self.assertTrue((self.journal / 'windows-definition-reconcile' / 'submit.failure.json').is_file())
        self.cfg['nonce'] = '9'*32
        with self.assertRaises(FileExistsError): r.execute(self.cfg)
        self.assertEqual(self.call.call_count, 2)

    def test_reader_requires_expired_local_clock(self):
        self.mono -= 1
        with self.assertRaises(ValueError): r.execute(self.cfg)
        self.call.assert_not_called()

    def test_reader_requires_expired_native_clock(self):
        self.sample_tick = self.original['windowsDeadlineMilliseconds'] - 1
        with self.assertRaises(ValueError): r.execute(self.cfg)
        self.assertEqual(self.call.call_count, 1)

    def test_reader_refuses_changed_native_boot(self):
        self.reader_mutate = lambda row: {**row, 'windowsBoot': 'f'*32}
        with self.assertRaises(ValueError): r.execute(self.cfg)
        self.assertEqual(self.call.call_count, 1)

    def test_reader_refuses_other_plan_or_channel(self):
        self.cfg['transport'] = copy.deepcopy(self.transport)
        self.cfg['transport']['target']['host'] = '192.0.2.6'
        with self.assertRaises(ValueError): r.execute(self.cfg)
        self.call.assert_not_called()

    def test_reader_refuses_old_nonce(self):
        self.cfg['nonce'] = '2'*32
        with self.assertRaises(ValueError): r.execute(self.cfg)
        self.call.assert_not_called()

    def test_reader_refuses_missing_submit(self):
        (self.journal / 'windows-define' / 'submit.intent').unlink()
        with self.assertRaises(FileNotFoundError): r.execute(self.cfg)
        self.call.assert_not_called()

    def test_reader_refuses_false_settlement_claim(self):
        def corrupt(row):
            if 'result' in row: row['result']['definitionSettled'] = True
            return row
        self.reader_mutate = corrupt
        with self.assertRaises(ValueError): r.execute(self.cfg)
        self.assertTrue((self.journal / 'windows-definition-reconcile' / 'response.json').is_file())
        self.assertFalse((self.journal / 'windows-definition-reconcile' / 'RESULT.json').exists())

    def test_reader_refuses_expired_bootstrap_without_submit(self):
        with mock.patch.object(r.time, 'monotonic_ns', side_effect=[0, 3_000_000_000]):
            with self.assertRaises(TimeoutError): r.execute(self.cfg)
        self.assertEqual(self.call.call_count, 1)
        self.assertFalse((self.journal / 'windows-definition-reconcile' / 'submit.intent').exists())


# Reuse fixture helpers without re-running inherited transition tests against
# the already-expired reconciliation setup. Those run separately unchanged.
for name in list(Transition.__dict__):
    if name.startswith('test_'):
        setattr(Reconciliation, name, None)
del Transition

if __name__ == '__main__':
    unittest.main()

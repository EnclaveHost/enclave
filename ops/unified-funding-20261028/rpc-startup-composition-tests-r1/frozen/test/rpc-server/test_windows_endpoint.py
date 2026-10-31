"""Actual four-phase owner journals and linkage; SSH/native replies mocked."""
import copy
import unittest
from unittest import mock
import test_windows_transition as fixture
import windows_endpoint as e

w, c = fixture.w, fixture.c


class Endpoint(unittest.TestCase):
    def setUp(self):
        self.x = fixture.Transition('runTest')
        self.x.setUp()
        self.addCleanup(self.x.tearDown)
        mock.patch.object(e, 'w', w).start()
        mock.patch.object(e, 'c', c).start()
        self.addCleanup(mock.patch.stopall)
        self.x.advance('cut-seed')
        cfg = self.x.config('define')
        obs = c.protocol.decode(c.read_pinned(cfg['observation']['binding']))
        self.network = {'schema': 'owned-rpc-boot-network/1', 'switchGuid': '00000000-0000-0000-0000-000000000002', 'mac': '021122334455'}
        obs['bootNetwork'] = self.network
        cfg['observation']['binding'] = self.x.bound('network-observation', c.encode(obs))
        plan = c.read_pinned(self.x.plan).decode().split('\n')
        plan[3] = cfg['observation']['binding']['sha256']
        self.x.plan = self.x.bound('network-plan', '\n'.join(plan).encode())
        cfg['input']['binding'] = self.x.plan
        self.x.previous = w.execute(cfg)
        self.x.advance('boot')
        self.x.advance('start-once')
        self.cfg = {'clock': self.x.clock, 'transport': self.x.transport, 'helper': self.x.image('vm-endpoint.exe'),
                    'nonce': '8'*32, 'startResult': self.x.previous, 'requiredFreeBytes': e.MINIMUM_FREE}
        self.x.call.reset_mock()
        self.x.call.side_effect = self.exchange
        self.change = lambda row: None
        self.origin = self.x.original['windowsDeadlineMilliseconds'] - 15000

    def exchange(self, argv, raw, seconds):
        folder = self.x.journal/'windows-endpoint'
        self.assertEqual(raw, b'')
        self.assertIn('-oStrictHostKeyChecking=yes', argv)
        self.assertTrue((folder/'sample.intent').is_file())
        if 'clock-sample.exe' in argv[-1]:
            self.assertLessEqual(seconds, 3)
            return c.encode({'schema': 'owned-rpc-windows-clock/1', 'attempt': self.cfg['nonce'],
                             'vmAttempt': 'b'*32, 'windowsBoot': 'c'*32, 'monotonicMilliseconds': self.origin})
        intent = c.protocol.decode(c.read(folder/'submit.intent'))
        self.assertEqual(intent['command'], argv[-1])
        self.assertEqual(intent['requestSha256'], c.protocol.sha(c.read(folder/'request.json')))
        expected = e.lineage(self.cfg, self.x.original)
        self.assertEqual(argv[-1].split(), [self.cfg['helper']['path'], expected['permitPath'], expected['permitSha256'],
                                          self.cfg['helper']['sha256'], str(self.origin), str(self.x.original['windowsDeadlineMilliseconds']), str(e.MINIMUM_FREE)])
        self.assertLessEqual(seconds, 32)
        row = dict(schema='owned-rpc-vm-endpoint/1', vmAttempt='b'*32, windowsBoot='c'*32,
                   permitSha256=expected['permitSha256'], vmGuid=self.x.guid,
                   switchGuid=self.network['switchGuid'], mac=self.network['mac'],
                   originalOrigin=self.x.original['windowsOriginMilliseconds'], originalDeadline=self.x.original['windowsDeadlineMilliseconds'],
                   origin=intent['origin'], deadline=intent['deadline'], port=22, hostAssociationObserved=True,
                   guestAuthenticated=False, attestationVerified=False, rpcReady=False, reservationMayRelease=False,
                   requiredFreeBytes=e.MINIMUM_FREE, freeBytes=e.MINIMUM_FREE+1048576,
                   nicReference='Msvm_SyntheticEthernetPortSettingData.InstanceID="fixture-nic"',
                   observedFrom=self.origin, observedAt=self.origin, ipv4='192.168.8.42',
                   envelope=dict(ProcessId=42, CreationFileTime=134375086385617521, JobCommitLimitBytes=128*1048576,
                                 BootstrapPrivateBytes=13000000, MembershipVerified=True, LimitsVerified=True,
                                 CoversPreAssignmentMemory=False, BoundsWallTime=False, ReservationMayRelease=False))
        self.change(row)
        self.last = row
        return c.encode(row)

    def test_original_full_chain_derives_exact_permit_and_endpoint(self):
        result = c.protocol.decode(c.read_pinned(e.observe(self.cfg)))
        self.assertEqual(result['endpoint'], {'host': '192.168.8.42', 'port': 22})
        self.assertFalse(result['pending'])
        for key in ('guestAuthenticated', 'providerSettlementProven', 'rpcReady', 'remoteDeathProven', 'reservationMayRelease'):
            self.assertFalse(result[key])
        plan = c.read_pinned(self.x.plan).decode().split('\n')
        raw = '\n'.join(['owned-rpc-vm-permit-v2', plan[1], plan[2], plan[3], plan[4], self.x.guid,
                          self.x.vmroot+'\\vm', plan[6], plan[7], '20401094656', '1073741824',
                          'fixed-local-start-disable-and-reconcile-v2', '']).encode()
        self.assertEqual(result['expected']['permitSha256'], c.protocol.sha(raw))
        self.assertEqual(self.x.call.call_count, 2)
        # Existing start reply is deliberately response-lost-held: observing
        # Running/address cannot relabel that ambiguous provider operation.
        start = c.protocol.decode(c.read_pinned(self.cfg['startResult']))
        self.assertIn('response-lost-held', start['native']['result'])

    def test_pending_is_preserved_without_guess_or_retry(self):
        self.change = lambda row: row.update(ipv4=None)
        result = c.protocol.decode(c.read_pinned(e.observe(self.cfg)))
        self.assertTrue(result['pending']); self.assertIsNone(result['endpoint'])
        self.cfg['nonce'] = '9'*32
        with self.assertRaises(FileExistsError): e.observe(self.cfg)
        self.assertEqual(self.x.call.call_count, 2)

    def test_lost_native_response_consumed_even_new_nonce(self):
        actual = self.exchange
        def lost(argv, raw, seconds):
            reply = actual(argv, raw, seconds)
            if 'vm-endpoint.exe' in argv[-1]: raise TimeoutError('lost observation')
            return reply
        self.x.call.side_effect = lost
        with self.assertRaises(TimeoutError): e.observe(self.cfg)
        self.cfg['nonce'] = '9'*32
        with self.assertRaises(FileExistsError): e.observe(self.cfg)
        self.assertEqual(self.x.call.call_count, 2)
        self.assertFalse((self.x.journal/'windows-endpoint/RESULT.json').exists())

    def test_lost_clock_does_not_launch_observer(self):
        self.x.call.side_effect = TimeoutError('sample missing')
        with self.assertRaises(TimeoutError): e.observe(self.cfg)
        with self.assertRaises(FileExistsError): e.observe(self.cfg)
        self.assertEqual(self.x.call.call_count, 1)
        self.assertFalse((self.x.journal/'windows-endpoint/submit.intent').exists())

    def test_original_plan_tamper_before_transport(self):
        from pathlib import Path
        path = Path(self.x.plan['path']); path.write_bytes(path.read_bytes()+b'x')
        with self.assertRaises(ValueError): e.observe(self.cfg)
        self.x.call.assert_not_called()

    def test_lineage_change_during_observation_is_held(self):
        def change(row):
            path = self.x.journal/'windows-start-once/response.json'
            path.write_bytes(path.read_bytes()+b' ')
        self.change = change
        with self.assertRaises(ValueError): e.observe(self.cfg)
        self.assertEqual(self.x.call.call_count, 2)
        self.assertFalse((self.x.journal/'windows-endpoint/RESULT.json').exists())

    def test_original_cut_evidence_tamper_before_transport(self):
        path = self.x.journal/'windows-cut-seed/response.json'; path.write_bytes(path.read_bytes()+b' ')
        with self.assertRaises(ValueError): e.observe(self.cfg)
        self.x.call.assert_not_called()

    def test_transport_change_before_query(self):
        self.cfg['transport'] = copy.deepcopy(self.cfg['transport']); self.cfg['transport']['target']['host'] = '192.0.2.6'
        with self.assertRaises(ValueError): e.observe(self.cfg)
        self.x.call.assert_not_called()

    def test_floor_cannot_omit_pending(self):
        self.cfg['requiredFreeBytes'] = (18432+256)*1048576
        with self.assertRaises(ValueError): e.observe(self.cfg)
        self.x.call.assert_not_called()

    def test_wrong_native_vm_or_network_is_not_endpoint(self):
        expected = e.lineage(self.cfg, self.x.original)
        e.observe(self.cfg); original = copy.deepcopy(self.last)
        for field, value in [('vmGuid', self.network['switchGuid']), ('mac', '021122334456'),
                             ('permitSha256', '0'*64), ('switchGuid', self.x.guid), ('guestAuthenticated', True),
                             ('rpcReady', True), ('originalDeadline', self.x.original['windowsDeadlineMilliseconds']+1),
                             ('nicReference', '\\\\remote\\root\\virtualization\\v2:foreign')]:
            row = copy.deepcopy(original); row[field] = value
            with self.assertRaises(ValueError):e.validate_reply(row, self.cfg, self.x.original, expected, self.origin, self.x.original['windowsDeadlineMilliseconds'], 0, 1000000)

    def test_stale_observation_and_future_ticks_refused(self):
        expected = e.lineage(self.cfg, self.x.original)
        e.observe(self.cfg); row = copy.deepcopy(self.last)
        with self.assertRaises(ValueError):e.validate_reply(row, self.cfg, self.x.original, expected, self.origin, self.x.original['windowsDeadlineMilliseconds'], 0, 2_000_000_000)
        row['observedAt'] = self.origin+2
        with self.assertRaises(ValueError):e.validate_reply(row, self.cfg, self.x.original, expected, self.origin, self.x.original['windowsDeadlineMilliseconds'], 0, 0)

    def test_invalid_envelope_and_host_refused(self):
        expected = e.lineage(self.cfg, self.x.original);e.observe(self.cfg);original = copy.deepcopy(self.last)
        for field, value in [('ProcessId', 0), ('JobCommitLimitBytes', 256*1048576), ('MembershipVerified', False), ('BoundsWallTime', True)]:
            row = copy.deepcopy(original); row['envelope'][field] = value
            with self.assertRaises(ValueError):e.validate_reply(row, self.cfg, self.x.original, expected, self.origin, self.x.original['windowsDeadlineMilliseconds'], 0, 1000000)
        for host in ('127.0.0.1', '169.254.1.1', '224.0.0.1', '010.1.1.1', '192.168.8.42;calc', '::1'):
            row = copy.deepcopy(original);row['ipv4'] = host
            with self.assertRaises(ValueError):e.validate_reply(row, self.cfg, self.x.original, expected, self.origin, self.x.original['windowsDeadlineMilliseconds'], 0, 1000000)

    def test_wrong_sample_boot_is_consumed_without_reader(self):
        self.x.call.side_effect = lambda *args: c.encode({'schema': 'owned-rpc-windows-clock/1', 'attempt': self.cfg['nonce'], 'vmAttempt': 'b'*32, 'windowsBoot': 'f'*32, 'monotonicMilliseconds': self.origin})
        with self.assertRaises(ValueError):e.observe(self.cfg)
        self.assertEqual(self.x.call.call_count, 1)
        self.assertFalse((self.x.journal/'windows-endpoint/submit.intent').exists())

    def test_short_original_remaining_time_no_transport(self):
        with mock.patch.object(c, 'remaining', return_value=4):
            with self.assertRaises(TimeoutError):e.observe(self.cfg)
        self.x.call.assert_not_called()

    def test_shell_metacharacter_image_refused(self):
        self.cfg['helper']['path'] += ' & calc'
        with self.assertRaises(ValueError):e.observe(self.cfg)
        self.x.call.assert_not_called()


if __name__ == '__main__': unittest.main(verbosity=2)

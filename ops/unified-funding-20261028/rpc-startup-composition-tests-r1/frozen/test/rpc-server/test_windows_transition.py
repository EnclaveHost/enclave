"""Real consumed journals and request linkage; native/SSH replies are fixtures."""
import base64
import copy
import hashlib
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'rpc'))
import windows_transition as w

c = w.c


class Transition(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ['RPC_TEST_ROOT'])
        self.root = Path(self.temp.name)
        self.wall, self.mono, self.boot = c.snapshot()
        self.snapshot = mock.patch.object(c, 'snapshot', lambda: (self.wall, self.mono, self.boot))
        self.snapshot.start()
        begin = c.begin(self.root, 'a'*32, 'rpc-owned-'+'a'*32, 'b'*32)
        self.journal = Path(begin['path']).parent
        sample = {'schema': 'owned-rpc-windows-clock/1', 'attempt': 'a'*32, 'vmAttempt': 'b'*32,
                  'windowsBoot': 'c'*32, 'monotonicMilliseconds': 1000000}
        self.clock = c.finish(begin, c.write_new(self.root/'initial-sample', c.encode(sample)))
        self.original = c.validate(self.clock)
        identity = c.write_new(self.root/'identity', b'not-a-private-key-test-fixture\n')
        host = b'\0\0\0\x0bssh-ed25519\0\0\0\x20'+bytes(range(32))
        known = c.write_new(self.root/'known', b'windows-phase ssh-ed25519 '+base64.b64encode(host)+b'\n')
        self.transport = {'target': {'host': '192.0.2.5', 'port': 22, 'user': 'testadmin', 'identityFile': identity['path']},
                          'hostAlias': 'windows-phase', 'knownHosts': known,
                          'sshSha256': hashlib.sha256(Path('/usr/bin/ssh').read_bytes()).hexdigest(),
                          'samplerPath': r'C:\EnclaveRpcClock-fixture\clock-sample.exe', 'samplerSha256': 'd'*64}
        self.prefix = r'C:\EnclaveRpcTransition-fixture\fixture'
        self.vmroot = 'C:\\EnclaveRpcVm-'+'b'*32+'\\'+'b'*32
        self.guid = '00000000-0000-0000-0000-000000000001'
        self.previous = None
        self.plan = None
        self.call = mock.patch.object(w.delivery, 'exchange', side_effect=self.exchange).start()
        self.addCleanup(mock.patch.stopall)
        self.mutate = lambda row: row
        self.counter = 0

    def tearDown(self):
        self.snapshot.stop()
        self.temp.cleanup()

    def bound(self, name, raw):
        self.counter += 1
        return c.write_new(self.root/(str(self.counter)+'-'+name), raw)

    def image(self, name, digest='e'*64):
        return {'path': self.prefix+'\\'+name, 'sha256': digest}

    def config(self, phase):
        self.phase = phase
        self.nonce = str(w.PHASES.index(phase)+1)*32
        binaries = {k: self.image(n) for k, n in zip(('controller', 'entry'), w.IMAGES[phase])}
        if phase == 'start-once':
            binaries['cleanup'] = self.image('cleanup-controller.exe', 'f'*64)
        obs = {'rc': 0, 'failure': None, 'readOnly': True,
               'observation': {'bootNative': 'c'*32, 'before': [1], 'after': [1], 'nodeExit': 0,
                               'manager': {'completeTransport': True, 'errors': []}}}
        if phase == 'define':
            prev = c.protocol.decode(c.read_pinned(self.previous))['native']
            seed = prev['inventory']['seed']
            obs['legacyCutSeed'] = {'contractPath': prev['root']+'\\contract.txt', 'manifestHash': prev['manifest']}
            obs['sharedPhysicalPool'] = {'configPath': seed['configPath'], 'configHash': seed['poolHash'], 'capacityBytes': seed['capacityBytes']}
        obs['startupCleanup'] = {'imageHash': 'f'*64}
        observed = {'path': self.prefix+'\\observation.json', 'binding': self.bound('observation', c.encode(obs))}
        if phase == 'cut-seed':
            raw = c.encode({'schema': 'legacy-memory-handoff/2', 'boot': 'c'*32})
            inputs = {'path': self.prefix+'\\handoff.json', 'binding': self.bound('handoff', raw)}
        else:
            if self.plan is None:
                raw = '\n'.join(['owned-rpc-definition/1', 'b'*32, 'c'*32, observed['binding']['sha256'],
                                 'e'*64, self.vmroot, str(self.original['windowsOriginMilliseconds']),
                                 str(self.original['windowsDeadlineMilliseconds']), '6'*64, '7'*64,
                                 'generation-2-ubuntu;guest=20401094656;support=1073741824;vcpus=4;start=false', '']).encode()
                self.plan = self.bound('plan', raw)
            inputs = {'path': (self.prefix if phase == 'define' else self.vmroot)+'\\definition-plan.txt', 'binding': self.plan}
        self.current = {'clock': self.clock, 'transport': self.transport, 'phase': phase, 'nonce': self.nonce,
                        'binaries': binaries, 'observation': observed, 'input': inputs, 'previous': self.previous}
        return self.current

    def exchange(self, argv, raw, seconds):
        folder = self.journal/('windows-'+self.phase)
        self.assertEqual(raw, b'')
        self.assertIn('-oStrictHostKeyChecking=yes', argv)
        self.assertIn('-F', argv)
        if 'clock-sample.exe' in argv[-1]:
            self.assertEqual(argv[-1].split(), [self.transport['samplerPath'], self.nonce, 'b'*32, 'd'*64])
            self.assertTrue((folder/'sample.intent').is_file())
            return c.encode({'schema': 'owned-rpc-windows-clock/1', 'attempt': self.nonce,
                             'vmAttempt': 'b'*32, 'windowsBoot': 'c'*32,
                             'monotonicMilliseconds': self.original['windowsDeadlineMilliseconds']-15000})
        submit = c.protocol.decode(c.read(folder/'submit.intent'))
        self.assertEqual(submit['command'], argv[-1])
        self.assertLessEqual(seconds, 32)
        self.assertEqual(submit['deadline'], self.original['windowsDeadlineMilliseconds'])
        kind = {'cut-seed': 'LegacyHandoff', 'define': 'Definition', 'boot': 'Definition', 'start-once': 'Startup'}[self.phase]
        row = {'origin': submit['origin'], 'deadline': submit['deadline'], 'failures': [], 'reservationMayRelease': False,
               'root': 'C:\\EnclaveRpc'+kind+'-'+self.nonce+'\\'+self.nonce}
        if self.phase == 'cut-seed':
            manifest = self.current['input']['binding']['sha256']
            row.update(schema='owned-rpc-target-legacy-handoff/1', passed=True, operation='legacy-memory-cut-seed-v1',
                       manifest=manifest, providerFenced=False, vmsChanged=False,
                       inventory={'seed': {'schema': 'legacy-pool-seed/2', 'boot': 'c'*32, 'manifest': manifest,
                                          'creationMode': 'retained-fenced-rpc-only/1', 'providerSettled': False,
                                          'capacityAdmitted': False, 'reservationMayRelease': False,
                                          'configPath': r'C:\Pool-fixture\pool.txt', 'poolHash': '9'*64, 'capacityBytes': 79267102720}})
        elif self.phase in ('define', 'boot'):
            result = {'guid': self.guid, 'startAuthorized': False}
            result.update({'state': 'defined-owned-off', 'definitionSettled': True} if self.phase == 'define'
                          else {'state': 'configured-owned-off', 'bootConfigured': True})
            row.update(schema='owned-rpc-target-definition/1', passed=True, operation=self.phase,
                       plan=self.current['input']['binding']['sha256'], result=result, startAuthorized=False)
        else:
            row.update(schema='owned-rpc-startup-controller/1', localWorkerCompleted=True, rpcReadinessProven=False,
                       independentTasksRetained=2, vmRoot=self.vmroot,
                       result='response-lost-held;settled=False;provider-fenced=false;reservation-release=false')
        return c.encode(self.mutate(row))

    def advance(self, phase):
        self.previous = w.execute(self.config(phase))
        return c.protocol.decode(c.read_pinned(self.previous))

    def test_four_phase_sequence_original_deadline_and_no_readiness(self):
        for phase in w.PHASES:
            result = self.advance(phase)
            self.assertFalse(result['rpcReady'])
            self.assertFalse(result['remoteDeathProven'])
            self.assertFalse(result['reservationMayRelease'])
        self.assertEqual(self.call.call_count, 8)
        self.assertIn('response-lost-held', result['native']['result'])
        args = self.call.call_args.args[0][-1].split()
        self.assertEqual(args[-4], 'start-once')
        self.assertEqual(args[-3], '4'*32)

    def test_replay_even_different_nonce_never_resubmits(self):
        config = self.config('cut-seed')
        w.execute(config)
        config['nonce'] = '8'*32
        with self.assertRaises(FileExistsError): w.execute(config)
        self.assertEqual(self.call.call_count, 2)

    def test_missing_predecessor_refused_before_transport(self):
        config = self.config('boot')
        with self.assertRaises(ValueError): w.execute(config)
        self.call.assert_not_called()

    def test_lost_controller_response_holds_without_receipt(self):
        normal = self.exchange
        def lost(argv, raw, seconds):
            if 'clock-sample.exe' in argv[-1]: return normal(argv, raw, seconds)
            raise TimeoutError('ambiguous remote submission')
        self.call.side_effect = lost
        config = self.config('cut-seed')
        with self.assertRaises(TimeoutError): w.execute(config)
        self.assertTrue((self.journal/'windows-cut-seed/submit.intent').exists())
        self.assertFalse((self.journal/'windows-cut-seed/RESULT.json').exists())
        with self.assertRaises(FileExistsError): w.execute(config)
        self.assertEqual(self.call.call_count, 2)

    def test_sample_loss_consumes_phase_without_submission(self):
        self.call.side_effect = TimeoutError('sample response lost')
        config = self.config('cut-seed')
        with self.assertRaises(TimeoutError): w.execute(config)
        with self.assertRaises(FileExistsError): w.execute(config)
        self.assertFalse((self.journal/'windows-cut-seed/submit.intent').exists())
        self.assertEqual(self.call.call_count, 1)

    def test_wrong_sample_boot_holds_before_mutation(self):
        self.call.side_effect = lambda *args: c.encode({'schema': 'owned-rpc-windows-clock/1', 'attempt': '1'*32,
            'vmAttempt': 'b'*32, 'windowsBoot': '8'*32, 'monotonicMilliseconds': 1000100})
        with self.assertRaises(ValueError): w.execute(self.config('cut-seed'))
        self.assertFalse((self.journal/'windows-cut-seed/submit.intent').exists())
        self.assertEqual(self.call.call_count, 1)

    def test_shell_injection_refused_before_transport(self):
        config = self.config('cut-seed')
        config['binaries']['controller']['path'] += ' & calc'
        with self.assertRaises(ValueError): w.execute(config)
        self.call.assert_not_called()

    def test_changed_definition_clock_refused(self):
        self.advance('cut-seed')
        config = self.config('define')
        raw = c.read_pinned(self.plan).replace(str(self.original['windowsDeadlineMilliseconds']).encode(), b'999999999')
        config['input']['binding'] = self.bound('reset-plan', raw)
        with self.assertRaises(ValueError): w.execute(config)
        self.assertEqual(self.call.call_count, 2)

    def test_changed_transport_refused(self):
        self.advance('cut-seed')
        config = self.config('define')
        config['transport'] = copy.deepcopy(config['transport'])
        config['transport']['target']['host'] = '192.0.2.6'
        with self.assertRaises(ValueError): w.execute(config)
        self.assertEqual(self.call.call_count, 2)

    def test_wrong_cut_binding_refused(self):
        self.advance('cut-seed')
        config = self.config('define')
        obs = c.protocol.decode(c.read_pinned(config['observation']['binding']))
        obs['legacyCutSeed']['contractPath'] = r'C:\Another\contract.txt'
        config['observation']['binding'] = self.bound('foreign-observation', c.encode(obs))
        raw = c.read_pinned(self.plan).replace(c.protocol.decode(c.read_pinned(self.previous))['native']['manifest'].encode(), b'0'*64)
        # First pin the changed observation into a structurally valid plan so
        # this exercises the cut association, not just a digest mismatch.
        fields = raw.decode().split('\n');fields[3] = config['observation']['binding']['sha256']
        config['input']['binding'] = self.bound('changed-plan', '\n'.join(fields).encode())
        with self.assertRaisesRegex(ValueError, 'cut/seed'): w.execute(config)
        self.assertEqual(self.call.call_count, 2)

    def test_unsettled_definition_cannot_advance(self):
        self.advance('cut-seed')
        def unsettled(row):
            row['result'].update(state='response-lost-held', definitionSettled=False, guid='')
            return row
        self.mutate = unsettled
        with self.assertRaises(ValueError): w.execute(self.config('define'))
        folder = self.journal/'windows-define'
        self.assertTrue((folder/'response.json').exists())
        self.assertFalse((folder/'RESULT.json').exists())

    def test_boot_wrong_guid_cannot_advance(self):
        self.advance('cut-seed');self.advance('define')
        def other(row):
            row['result']['guid'] = '00000000-0000-0000-0000-000000000002'
            return row
        self.mutate = other
        with self.assertRaisesRegex(ValueError, 'identity'): w.execute(self.config('boot'))
        self.assertFalse((self.journal/'windows-boot/RESULT.json').exists())

    def test_expired_original_window_never_submits(self):
        config = self.config('cut-seed')
        self.wall += 900_000_000_000;self.mono += 900_000_000_000
        with self.assertRaises(ValueError): w.execute(config)
        self.call.assert_not_called()

    def test_changed_previous_response_refused(self):
        self.advance('cut-seed')
        path = self.journal/'windows-cut-seed/response.json'
        path.write_bytes(path.read_bytes()+b' ')
        with self.assertRaisesRegex(ValueError, 'evidence'): w.execute(self.config('define'))
        self.assertEqual(self.call.call_count, 2)

    def preparation(self):
        cut = self.advance('cut-seed')
        native = cut['native']
        request = c.protocol.decode(c.read(self.journal/'windows-cut-seed/request.json'))
        contract = '\n'.join(['owned-rpc-legacy-handoff-v1', request['nonce'], 'c'*32,
                              str(native['origin']), str(native['deadline']), 'e'*64,
                              'legacy-memory-cut-seed-v1', native['manifest'], '']).encode()
        activation = c.encode(native['inventory']['seed'])
        obs = c.protocol.decode(c.read_pinned(request['observation']['binding']))
        obs.pop('startupCleanup')
        media = {'schema': 'rpc-staged-client-media-binding/1', 'instance': self.original['instance'],
                 'files': [{'name': 'boot.vhdx', 'bytes': 2301624320, 'sha256': '6'*64, 'privateAcl': True},
                           {'name': 'seed.iso', 'bytes': 13236224, 'sha256': '7'*64, 'privateAcl': True}]}
        return {'clock': self.clock, 'cutResult': self.previous,
                'cutEvidence': {'contract': self.bound('contract', contract),
                                'activation': self.bound('activation', activation),
                                'complete': self.bound('complete', c.protocol.sha(activation).encode())},
                'observation': self.bound('observed', c.encode(obs)), 'media': self.bound('media', c.encode(media)),
                'providerSha256': 'e'*64, 'cleanupSha256': 'f'*64,
                'network': {'schema': 'owned-rpc-boot-network/1', 'switchGuid': self.guid, 'mac': '020000000001'}}

    def test_prepared_definition_uses_exact_evidence_and_original_clock(self):
        config = self.preparation()
        result = c.protocol.decode(c.read_pinned(w.prepare_definition(config)))
        plan = w.definition(c.read_pinned(result['plan']), self.original)
        admission = c.protocol.decode(c.read_pinned(result['admission']))
        self.assertEqual(plan[3], result['admission']['sha256'])
        self.assertEqual(plan[8:10], ['6'*64, '7'*64])
        self.assertEqual(admission['legacyCutSeed']['activationHash'], config['cutEvidence']['activation']['sha256'])
        self.assertEqual(admission['startupCleanup']['reservedBytes'], 192*1048576)
        self.assertFalse(result['nativeDefinitionSubmitted'])
        self.assertFalse(result['capacityAdmitted'])
        self.assertEqual(self.call.call_count, 2)  # Preparation starts no transport.
        with self.assertRaises(FileExistsError): w.prepare_definition(config)
        # The real producer output is consumed directly by the phase sender.
        phase = self.config('define')
        phase['observation']['binding'] = result['admission']
        phase['input']['binding'] = result['plan']
        self.current = phase
        self.assertTrue(c.protocol.decode(c.read_pinned(w.execute(phase)))['completed'])

    def test_preparation_rejects_wrong_completion_digest(self):
        config = self.preparation()
        config['cutEvidence']['complete'] = self.bound('bad-complete', b'0'*64)
        with self.assertRaisesRegex(ValueError, 'completion'): w.prepare_definition(config)
        self.assertFalse((self.journal/'definition-inputs').exists())

    def test_preparation_rejects_changed_cut_contract(self):
        config = self.preparation()
        config['cutEvidence']['contract'] = self.bound('bad-contract', c.read_pinned(config['cutEvidence']['contract'])+b'\n')
        with self.assertRaisesRegex(ValueError, 'contract'): w.prepare_definition(config)
        self.assertFalse((self.journal/'definition-inputs').exists())

    def test_preparation_rejects_foreign_media(self):
        config = self.preparation()
        media = c.protocol.decode(c.read_pinned(config['media']))
        media['instance'] = 'rpc-owned-other'
        config['media'] = self.bound('foreign-media', c.encode(media))
        with self.assertRaisesRegex(ValueError, 'media'): w.prepare_definition(config)
        self.assertFalse((self.journal/'definition-inputs').exists())

    def test_preparation_cannot_replace_existing_admission(self):
        config = self.preparation()
        obs = c.protocol.decode(c.read_pinned(config['observation']))
        obs['legacyCutSeed'] = {}
        config['observation'] = self.bound('prior-admission', c.encode(obs))
        with self.assertRaisesRegex(ValueError, 'preexisting'): w.prepare_definition(config)
        self.assertFalse((self.journal/'definition-inputs').exists())

    def test_preparation_rejects_oversized_media(self):
        config = self.preparation()
        media = c.protocol.decode(c.read_pinned(config['media']))
        media['files'][0]['bytes'] = 4294967297
        config['media'] = self.bound('oversized-media', c.encode(media))
        with self.assertRaisesRegex(ValueError, 'growth limit'): w.prepare_definition(config)
        self.assertFalse((self.journal/'definition-inputs').exists())


if __name__ == '__main__': unittest.main(verbosity=2)

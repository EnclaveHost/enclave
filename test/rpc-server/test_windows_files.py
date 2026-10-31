"""Real owner journals and source composition; SSH/native replies are mocked."""
import base64
import copy
import unittest
from unittest import mock
import test_windows_transition as fixture
import windows_files as f

w, c = fixture.w, fixture.c


class Files(unittest.TestCase):
    def setUp(self):
        self.x = fixture.Transition('runTest')
        self.x.setUp()
        self.addCleanup(self.x.tearDown)
        mock.patch.object(f, 'w', w).start()
        mock.patch.object(f, 'c', c).start()
        self.addCleanup(mock.patch.stopall)
        self.change = lambda row: row

    def base(self):
        return dict(clock=self.x.clock, transport=self.x.transport,
                    helper=self.x.image('transition-files.exe'), nonce='8'*32)

    def install(self, config, operation, journal):
        self.config, self.operation, self.journal = config, operation, journal
        self.x.call.reset_mock()
        self.x.call.side_effect = self.exchange
        return config

    def stage(self, phase='cut-seed'):
        cfg = self.x.config(phase)
        config = self.base()
        config.update(phase=phase, files={'observation.json': cfg['observation']['binding']})
        if phase == 'define': config['files']['definition-plan.txt'] = cfg['input']['binding']
        return self.install(config, 'stage-inputs', 'stage-'+phase)

    def exchange(self, argv, raw, seconds):
        root = self.x.journal/('windows-files-'+self.journal)
        self.assertIn('-oStrictHostKeyChecking=yes', argv)
        self.assertIn('-F', argv)
        self.assertLessEqual(seconds, 32)
        self.assertTrue((root/'sample.intent').is_file())
        if 'clock-sample.exe' in argv[-1]:
            self.assertEqual(raw, b'')
            return c.encode(dict(schema='owned-rpc-windows-clock/1', attempt=self.config['nonce'],
                vmAttempt='b'*32, windowsBoot='c'*32,
                monotonicMilliseconds=self.x.original['windowsDeadlineMilliseconds']-15000))
        submit = c.protocol.decode(c.read(root/'submit.intent'))
        self.assertEqual(submit['command'], argv[-1])
        self.assertEqual(submit['requestSha256'], c.protocol.sha(raw))
        self.assertEqual(submit['deadline'], self.x.original['windowsDeadlineMilliseconds'])
        request = c.protocol.decode(raw)
        self.assertEqual(request['deadline'], self.x.original['windowsDeadlineMilliseconds'])
        payload = request['payload']
        if self.operation == 'stage-inputs':
            result = {'root': 'C:\\EnclaveRpcInputs-'+self.config['nonce']+'\\'+self.config['nonce'],
                      'files': [dict(name=r['name'], sha256=r['sha256'], bytes=len(base64.b64decode(r['base64']))) for r in payload['files']]}
        elif self.operation == 'collect-cut':
            result = {'root': payload['root'], 'files': [dict(name=name, bytes=len(value),
                sha256=c.protocol.sha(value), base64=base64.b64encode(value).decode()) for name, value in self.cut_files.items()]}
        else:
            result = dict(root=self.x.vmroot, sourceRoot=payload['sourceRoot'], planHash=payload['planHash'],
                files=[{k:r[k] for k in ('name','bytes','sha256')} for r in self.media['files']],
                definitionJournalBound=True, currentVmOffObserved=False, mediaAttached=False, privateContentsPrinted=False)
        row = dict(schema='owned-rpc-transition-files-result/1', operation=self.operation, nonce=self.config['nonce'],
            requestHash=c.protocol.sha(raw), windowsBoot='c'*32, vmAttempt='b'*32,
            origin=submit['origin'], deadline=submit['deadline'], result=result, pid=20, creation=12345,
            envelope=dict(MembershipVerified=True, LimitsVerified=True, JobCommitLimitBytes=128*1048576,
                BootstrapPrivateBytes=12*1048576, ProcessId=20, CreationFileTime=12345),
            vmChanged=False, rpcReady=False, reservationMayRelease=False)
        return c.encode(self.change(row))

    def collected(self):
        prep = self.x.preparation()
        self.cut_files = {name:c.read_pinned(prep['cutEvidence'][key]) for key,name in
            [('contract','contract.txt'),('activation','pool.activation'),('complete','pool.complete')]}
        config = self.base();config['cutResult'] = self.x.previous
        return prep, self.install(config, 'collect-cut', 'collect-cut')

    def copying(self):
        prep = self.x.preparation()
        self.media = c.protocol.decode(c.read_pinned(prep['media']))
        self.media['root'] = 'C:\\EnclaveRpcPrivateMedia-'+'9'*32+'\\'+'9'*32
        prep['media'] = self.x.bound('media-root', c.encode(self.media))
        prepared = w.prepare_definition(prep)
        produced = c.protocol.decode(c.read_pinned(prepared))
        config = self.x.config('define')
        config['observation']['binding'] = produced['admission']
        config['input']['binding'] = produced['plan']
        defined = w.execute(config)
        config = self.base();config.update(definitionResult=defined, preparedDefinition=prepared)
        return self.install(config, 'copy-media', 'copy-media')

    def test_stage_producer_output_feeds_phase_sender(self):
        config = self.stage()
        result = c.protocol.decode(c.read_pinned(f.stage_inputs(config)))
        self.assertFalse(result['rpcReady']);self.assertFalse(result['remoteDeathProven'])
        phase = self.x.current
        phase['observation'] = result['result']['files']['observation.json']
        self.x.call.side_effect = self.x.exchange
        self.assertTrue(c.protocol.decode(c.read_pinned(w.execute(phase)))['completed'])

    def test_stage_replay_different_nonce_cannot_resubmit(self):
        config = self.stage();f.stage_inputs(config)
        config['nonce'] = '9'*32
        with self.assertRaises(FileExistsError): f.stage_inputs(config)
        self.assertEqual(self.x.call.call_count, 2)

    def test_lost_ack_consumed_without_result_or_retry(self):
        config = self.stage();normal = self.exchange
        def lost(argv, raw, seconds):
            if raw: raise TimeoutError('ambiguous remote stage')
            return normal(argv, raw, seconds)
        self.x.call.side_effect = lost
        with self.assertRaises(TimeoutError): f.stage_inputs(config)
        root = self.x.journal/'windows-files-stage-cut-seed'
        self.assertTrue((root/'submit.intent').is_file());self.assertFalse((root/'RESULT.json').exists())
        with self.assertRaises(FileExistsError): f.stage_inputs(config)
        self.assertEqual(self.x.call.call_count, 2)

    def test_wrong_sample_boot_never_submits(self):
        config = self.stage()
        self.x.call.side_effect = lambda *args: c.encode(dict(schema='owned-rpc-windows-clock/1',
            attempt='8'*32, vmAttempt='b'*32, windowsBoot='0'*32, monotonicMilliseconds=1000200))
        with self.assertRaises(ValueError): f.stage_inputs(config)
        self.assertFalse((self.x.journal/'windows-files-stage-cut-seed/submit.intent').exists())
        self.assertEqual(self.x.call.call_count, 1)

    def test_changed_readback_stays_held(self):
        config = self.stage()
        def change(row): row['result']['files'][0]['sha256']='0'*64;return row
        self.change = change
        with self.assertRaisesRegex(ValueError, 'readback'): f.stage_inputs(config)
        root = self.x.journal/'windows-files-stage-cut-seed'
        self.assertTrue((root/'response.json').is_file());self.assertFalse((root/'RESULT.json').exists())

    def test_process_envelope_identity_mismatch_refused(self):
        config = self.stage()
        def change(row): row['envelope']['CreationFileTime']+=1;return row
        self.change = change
        with self.assertRaisesRegex(ValueError, 'envelope'): f.stage_inputs(config)

    def test_original_expiry_refused_before_transport(self):
        config = self.stage();self.x.wall+=900_000_000_000;self.x.mono+=900_000_000_000
        with self.assertRaises(ValueError): f.stage_inputs(config)
        self.x.call.assert_not_called()

    def test_invalid_file_name_refused_before_transport(self):
        config = self.stage();config['files']['seed.iso']=config['files']['observation.json']
        with self.assertRaises(ValueError): f.stage_inputs(config)
        self.x.call.assert_not_called()

    def test_collect_exact_raw_completion_feeds_definition_and_stage(self):
        prep,config = self.collected()
        result = c.protocol.decode(c.read_pinned(f.collect_cut(config)))
        prep['cutEvidence'] = result['result']['cutEvidence']
        produced = c.protocol.decode(c.read_pinned(w.prepare_definition(prep)))
        config = self.base();config['nonce']='9'*32
        config.update(phase='define', files={'observation.json':produced['admission'],'definition-plan.txt':produced['plan']})
        self.install(config,'stage-inputs','stage-define')
        staged = c.protocol.decode(c.read_pinned(f.stage_inputs(config)))
        self.assertEqual(set(staged['result']['files']),set(config['files']))

    def test_collect_wrong_raw_completion_refused(self):
        _,config = self.collected();self.cut_files['pool.complete']=b'0'*64
        with self.assertRaisesRegex(ValueError, 'completed cut'): f.collect_cut(config)
        self.assertFalse((self.x.journal/'windows-files-collect-cut/RESULT.json').exists())

    def test_copy_exact_defined_media_metadata_without_secret_transport(self):
        config = self.copying()
        result = c.protocol.decode(c.read_pinned(f.copy_media(config)))
        self.assertTrue(result['result']['mediaCopy']['definitionJournalBound'])
        self.assertFalse(result['result']['mediaCopy']['mediaAttached'])
        wire = c.protocol.decode(self.x.call.call_args.args[1])
        self.assertEqual(set(wire['payload']), {'sourceRoot','planHash'})
        with self.assertRaises(FileExistsError): f.copy_media(config)
        self.assertEqual(self.x.call.call_count,2)

    def test_copy_wrong_destination_hash_refused(self):
        config = self.copying()
        def change(row): row['result']['files'][1]['sha256']='0'*64;return row
        self.change = change
        with self.assertRaisesRegex(ValueError, 'destination readback'): f.copy_media(config)

    def test_copy_foreign_prepared_plan_refused_before_transport(self):
        config = self.copying()
        row = c.protocol.decode(c.read_pinned(config['preparedDefinition']))
        row['vmRoot'] = 'C:\\Other\\Other'
        config['preparedDefinition'] = self.x.bound('foreign-prepared', c.encode(row))
        with self.assertRaisesRegex(ValueError,'prepared/defined'): f.copy_media(config)
        self.x.call.assert_not_called()


if __name__ == '__main__': unittest.main(verbosity=2)

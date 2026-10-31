"""Actual owner producers/journals across two clocks; SSH/native replies mocked.

These checks do not prove old native process death, provider settlement or live
successor startup. The native predecessor binding is mandatory in the sender.
"""
import copy
from pathlib import Path
import unittest
from unittest import mock
import test_run_startup as fixture

r, w, c = fixture.r, fixture.w, fixture.c


class RetainedCut(unittest.TestCase):
    def setUp(self):
        self.s = fixture.Startup('runTest');self.s.setUp();self.addCleanup(self.s.doCleanups)
        self.x = self.s.x
        self.s.fail = 'define'
        with self.assertRaises(TimeoutError):r.run(self.s.cfg)
        self.old_clock = self.x.clock;self.old_journal = self.x.journal
        self.retained = {'clock': self.old_clock, 'cutResult': self.pin(self.old_journal/'windows-cut-seed/RESULT.json'),
                         'collectedCut': self.pin(self.old_journal/'windows-files-collect-cut/RESULT.json')}
        self.old_bytes = {p:p.read_bytes() for p in self.old_journal.rglob('*') if p.is_file()}
        self.x.wall += 901_000_000_000;self.x.mono += 901_000_000_000
        self.new_clock()
        self.s.fail = None;self.s.native_calls.clear();self.x.call.reset_mock()
        self.s.start.reset_mock();self.s.owner.reset_mock()

    def pin(self,path):return {'path':str(path),'sha256':c.protocol.sha(c.read(path))}

    def new_clock(self, vm='e'*32, boot='c'*32):
        begin = c.begin(self.x.root,'d'*32,'rpc-owned-'+'d'*32,vm)
        self.x.clock = c.finish(begin,self.x.bound('new-sample',c.encode({'schema':'owned-rpc-windows-clock/1',
            'attempt':'d'*32,'vmAttempt':vm,'windowsBoot':boot,'monotonicMilliseconds':2000000})))
        self.x.journal = Path(self.x.clock['path']).parent;self.x.original = c.validate(self.x.clock)
        self.x.vmroot = 'C:\\EnclaveRpcVm-'+vm+'\\'+vm
        self.s.e.origin = self.x.original['windowsDeadlineMilliseconds']-15000
        cfg=self.s.cfg;cfg['clock']=self.x.clock;cfg.pop('handoff');cfg['retainedCut']=self.retained
        cfg['nonces']={name:format(100+i,'032x') for i,name in enumerate(r.NONCES)}
        media=c.protocol.decode(c.read_pinned(cfg['media']));media['instance']=self.x.original['instance']
        media['files'][1]['sha256']='8'*64
        cfg['media']=self.x.bound('new-media',c.encode(media));self.s.f.media=media
        self.s.contract=self.x.bound('new-export-contract',c.encode({'startupClock':self.x.clock,'attempt':'d'*32,'stateParent':str(self.x.root/'state')}))
        self.s.prepare.return_value={'contract':self.s.contract}

    def adopt(self):return w.adopt_retained_cut({'clock':self.x.clock,'transport':self.x.transport,'retained':self.retained})

    def test_successor_composition_skips_cut_and_collect_preserves_history(self):
        row=c.protocol.decode(c.read_pinned(r.run(self.s.cfg)))
        self.assertEqual(self.s.native_calls,['stage-definition','define','copy','boot','start-once','endpoint'])
        self.assertTrue(row['clientProcessesObserved']);self.assertFalse(row['rpcReady'])
        adoption=c.protocol.decode(c.read(self.x.journal/'retained-cut/RESULT.json'))
        for name in ('nativeCutSubmitted','nativePredecessorVerified','capacityAdmitted','rpcReady','reservationMayRelease'):
            self.assertFalse(adoption[name])
        self.assertNotIn('native',adoption)
        admission=c.protocol.decode(c.read(self.x.journal/'definition-inputs/observation.json'))
        self.assertEqual(admission['unsubmittedPredecessor'],adoption['unsubmittedPredecessor'])
        old_request=c.protocol.decode(c.read(self.old_journal/'windows-define/request.json'))
        self.assertIn(old_request['nonce'],adoption['unsubmittedPredecessor']['contractPath'])
        self.assertEqual(self.old_bytes,{p:p.read_bytes() for p in self.old_journal.rglob('*') if p.is_file()})
        self.assertFalse((self.x.journal/'windows-cut-seed').exists())
        self.assertFalse((self.x.journal/'windows-files-collect-cut').exists())

    def test_historical_inspection_never_renews_active_deadline(self):
        self.assertEqual(c.inspect_historical(self.old_clock)['attempt'],'a'*32)
        with self.assertRaisesRegex(ValueError,'expired'):c.validate(self.old_clock)
        with self.assertRaisesRegex(ValueError,'expired'):c.remaining(self.old_clock)

    def test_adoption_is_one_shot_and_no_transport(self):
        self.adopt()
        with self.assertRaises(FileExistsError):self.adopt()
        self.x.call.assert_not_called()

    def test_corrupt_original_response_refused_before_export(self):
        path=self.old_journal/'windows-cut-seed/response.json';path.write_bytes(path.read_bytes()+b' ')
        with self.assertRaisesRegex(ValueError,'evidence'):r.run(self.s.cfg)
        self.s.start.assert_not_called();self.x.call.assert_not_called()

    def test_collection_rebinding_refused_before_adoption(self):
        path=self.old_journal/'windows-files-collect-cut/response.json';path.write_bytes(path.read_bytes()+b' ')
        with self.assertRaises(ValueError):self.adopt()
        self.assertFalse((self.x.journal/'retained-cut').exists());self.x.call.assert_not_called()

    def test_changed_original_definition_submit_refused(self):
        path=self.old_journal/'windows-define/submit.intent';row=c.protocol.decode(c.read(path));row['command']+=' x';path.write_bytes(c.encode(row))
        with self.assertRaisesRegex(ValueError,'command'):self.adopt()
        self.x.call.assert_not_called()

    def test_later_original_phase_refused(self):
        (self.old_journal/'windows-boot').mkdir(mode=0o700)
        with self.assertRaisesRegex(ValueError,'Later original'):self.adopt()
        self.x.call.assert_not_called()

    def test_original_nonce_reuse_refused_before_work(self):
        prior=c.protocol.decode(c.read(self.old_journal/'windows-define/request.json'))
        self.s.cfg['nonces']['define']=prior['nonce']
        with self.assertRaisesRegex(ValueError,'nonce'):r.run(self.s.cfg)
        self.s.start.assert_not_called();self.s.owner.assert_not_called()

    def test_changed_channel_refused_before_work(self):
        self.s.cfg['windows']['transport']=copy.deepcopy(self.x.transport)
        self.s.cfg['windows']['transport']['target']['host']='192.0.2.99'
        with self.assertRaises(ValueError):r.run(self.s.cfg)
        self.s.start.assert_not_called()

    def test_lost_successor_definition_remains_held_without_cut_replay(self):
        self.s.fail='define'
        with self.assertRaises(TimeoutError):r.run(self.s.cfg)
        self.assertEqual(self.s.native_calls,['stage-definition','define'])
        self.s.held('define');before=self.x.call.call_count
        with self.assertRaises(FileExistsError):r.run(self.s.cfg)
        self.assertEqual(before,self.x.call.call_count)

    def test_omitted_native_predecessor_binding_refused_before_submit(self):
        normal=w.prepare_definition
        def remove(config):
            binding=normal(config);result=c.protocol.decode(c.read_pinned(binding))
            admission=c.protocol.decode(c.read_pinned(result['admission']));admission.pop('unsubmittedPredecessor')
            raw=c.encode(admission);Path(result['admission']['path']).write_bytes(raw);result['admission']['sha256']=c.protocol.sha(raw)
            plan=c.read_pinned(result['plan']).decode().split('\n');plan[3]=result['admission']['sha256'];raw='\n'.join(plan).encode()
            Path(result['plan']['path']).write_bytes(raw);result['plan']['sha256']=c.protocol.sha(raw)
            Path(binding['path']).write_bytes(c.encode(result));return self.pin(Path(binding['path']))
        with mock.patch.object(w,'prepare_definition',side_effect=remove):
            with self.assertRaisesRegex(ValueError,'predecessor guard'):r.run(self.s.cfg)
        self.assertEqual(self.s.native_calls,['stage-definition'])
        self.assertFalse((self.x.journal/'windows-define').exists())

    def test_boot_overlap_and_vm_reuse_are_refused(self):
        old=c.inspect_historical(self.old_clock)
        for i,kind in enumerate(('windows-boot','vm-reuse','local-overlap','windows-overlap')):
            wall,mono=self.x.wall,self.x.mono
            if kind=='local-overlap':
                self.x.wall=old['createdUtcNs']+100_000_000_000;self.x.mono=old['originMonotonicNs']+100_000_000_000
            attempt=format(500+i,'032x');vm=old['vmAttempt'] if kind=='vm-reuse' else format(600+i,'032x')
            begin=c.begin(self.x.root,attempt,'rpc-owned-'+attempt,vm)
            sample={'schema':'owned-rpc-windows-clock/1','attempt':attempt,'vmAttempt':vm,
                    'windowsBoot':'f'*32 if kind=='windows-boot' else old['windowsBoot'],
                    'monotonicMilliseconds':1001000 if kind=='windows-overlap' else 2000000}
            binding=c.finish(begin,self.x.bound('other-clock',c.encode(sample)))
            with self.assertRaisesRegex(ValueError,'Distinct successor'):
                w.retained_source(self.retained,binding,self.x.transport)
            self.x.wall,self.x.mono=wall,mono
        self.x.call.assert_not_called()

    def test_adoption_mutation_after_receipt_refused(self):
        receipt=self.adopt();path=self.old_journal/'windows-files-collect-cut/pool.complete';path.write_bytes(b'0'*64)
        with self.assertRaises(ValueError):w.validate_retained_cut(receipt,self.x.clock,self.x.transport,'f'*32)
        self.x.call.assert_not_called()


if __name__=='__main__':unittest.main(verbosity=2)

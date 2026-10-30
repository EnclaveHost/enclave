"""Root fixtures: no remote execution, COW access, or real service mutation."""
import copy,json,unittest,tempfile,os,types,contextlib
from pathlib import Path
from test_source import funcs


class MerklePhase(unittest.TestCase):
    def setUp(self):
        self.g=funcs('recovery-progress.py');self.c=self.g['recovery_clock'](0)
        self.d={'sameIncarnation':True,'identity':{'pid':1,'startTicks':10,'invocationID':'a'*32,'procIdentity':[1,2]},
                'io':{'read_bytes':0,'write_bytes':0},'stat':{'userTicks':0,'systemTicks':0}}
        self.start={'micros':100,'marker':('Starting unwind','MerkleUnwind',(('from',30),('to',0)))}
        self.step(0,[self.start])
    def step(self,t,events=()):
        events=[dict(e,cursor=e.get('cursor',str(e['micros'])+repr(e['marker']))) for e in events]
        return self.g['advance_recovery'](self.c,t,self.d,[e['marker'] for e in events],events)
    def work(self,t):
        self.d['io']['read_bytes']+=1;return self.step(t,[self.start])
    def test_progressing_merkle_survives_semantic_boundary(self):
        self.work(299);self.work(590);self.assertIsNone(self.work(600))
        self.assertEqual(self.c['lastSemantic'],0)
    def test_replayed_event_does_not_reset_phase_entry(self):
        self.work(200);self.assertEqual(self.c['phaseObservedAt'],0)
    def test_no_counter_progress_never_exempts(self):
        self.assertEqual(self.step(600,[self.start]),'recovery-semantic-progress-limit')
    def test_stale_diagnostic_loses_exception(self):
        self.work(590);self.assertEqual(self.g['recovery_stop_reason'](self.c,606),'recovery-semantic-progress-limit')
    def test_absolute_limit_still_applies(self):
        self.work(3599);self.assertEqual(self.work(3600),'recovery-window-ended')
    def test_counter_reset_refused_in_merkle(self):
        self.work(590);self.d['io']['read_bytes']=0
        with self.assertRaisesRegex(AssertionError,'counter-reset'):self.step(600)
    def test_stage_end_revokes_exception(self):
        self.work(590);self.step(600,[{'micros':200,'marker':('Stage unwound','MerkleUnwind',())}])
        self.assertIsNone(self.c['phase']);self.assertFalse(self.g['recovery_clock_evidence'](self.c,600)['checkpointCommitProven'])
    def test_same_timestamp_stage_end_is_not_lost(self):
        self.step(1,[{'micros':101,'marker':self.start['marker']},{'micros':101,'marker':('Stage unwound','MerkleUnwind',())}])
        self.assertIsNone(self.c['phase'])
    def test_equal_time_completion_next_poll_is_not_lost(self):
        self.step(1,[{'micros':100,'marker':('Stage unwound','MerkleUnwind',(('done',True),))}]);self.assertIsNone(self.c['phase'])
    def test_partial_batch_keeps_phase(self):
        self.step(1,[{'micros':101,'marker':('Stage unwound','MerkleUnwind',(('done',False),('progress',20),('unwind_to',0)))}]);self.assertEqual(self.c['phase'],'MerkleUnwind')
    def test_other_stage_never_exempts(self):
        self.step(1,[{'micros':101,'marker':('Starting unwind','Finish',())}]);self.work(600)
        self.assertEqual(self.work(601),'recovery-semantic-progress-limit')
    def test_nonchronological_events_refused(self):
        with self.assertRaisesRegex(AssertionError,'chronological'):self.step(1,[{'micros':102,'marker':self.start['marker']},self.start])
    def test_clock_cannot_move_backward(self):
        self.work(2)
        with self.assertRaisesRegex(AssertionError,'clock-reversed'):self.step(1)
    def test_no_work_limit_not_removed(self):
        self.work(1);self.assertEqual(self.step(301),'recovery-no-work-limit')


class JournalEvents(unittest.TestCase):
    def setUp(self):
        self.inv='a'*32;self.boot='b'*32
        self.row={'MESSAGE':'Starting unwind stage=MerkleUnwind from=30 to=0','_SYSTEMD_INVOCATION_ID':self.inv,'_BOOT_ID':self.boot,'__MONOTONIC_TIMESTAMP':'100','__CURSOR':'s=fixture;i=1'}
        self.g=funcs('recovery-progress.py',{'M':{'bootId':self.boot}})
        self.g['capture']=lambda *a,**k:{'rc':0,'reason':None,'truncated':False,'stdout':json.dumps(self.row)}
    def test_exact_event(self):self.assertEqual(self.g['sample_recovery_events']({'InvocationID':self.inv})[0]['micros'],100)
    def test_wrong_boot(self):
        self.row['_BOOT_ID']='c'*32
        with self.assertRaisesRegex(AssertionError,'boot'):self.g['sample_recovery_events']({'InvocationID':self.inv})
    def test_missing_monotonic_time(self):
        del self.row['__MONOTONIC_TIMESTAMP']
        with self.assertRaisesRegex(AssertionError,'event-time'):self.g['sample_recovery_events']({'InvocationID':self.inv})


class ExitReceipt(unittest.TestCase):
    def setUp(self):
        self.g=funcs('exit-recorder.py')
        self.b={'boot':'boot','nonce':'nonce','unit':'unit','invocation':'a'*32,'description':'owned','user':'client',
                'pid':10,'startTicks':11,'mainStartMonotonic':'100','cgroup':'/owned','cgroupIdentity':[1,2]}
        self.i={'InvocationID':'a'*32,'Description':'owned','User':'client','ControlGroup':'/owned','Transient':'yes',
                'ExecMainPID':'10','ExecMainStartTimestampMonotonic':'100','ControlPID':'20','ActiveState':'deactivating',
                'SubState':'stop-post','Result':'success','ExecMainCode':'1','ExecMainStatus':'0'}
        self.p={'pid':20,'startTicks':'30','cgroup':'0::/owned','isTimeout':True,'argvMatches':True}
    def check(self):return self.g['validate_exit'](self.b,self.i,self.p,'boot')
    def test_bound_success(self):self.assertTrue(self.check()['managerStopPostVerified'])
    def test_kill_is_retained_as_failure_evidence(self):
        self.i.update(Result='timeout',ExecMainCode='2',ExecMainStatus='9');self.assertEqual(self.check()['Result'],'timeout')
    def test_foreign_invocation(self):
        self.i['InvocationID']='b'*32
        with self.assertRaisesRegex(AssertionError,'invocation'):self.check()
    def test_reused_main_pid(self):
        self.i['ExecMainStartTimestampMonotonic']='101'
        with self.assertRaisesRegex(AssertionError,'start'):self.check()
    def test_foreign_control_parent(self):
        self.i['ControlPID']='21'
        with self.assertRaisesRegex(AssertionError,'control-parent'):self.check()
    def test_wrong_parent_command(self):
        self.p['argvMatches']=False
        with self.assertRaisesRegex(AssertionError,'timeout-parent'):self.check()
    def test_non_stop_post(self):
        self.i['SubState']='running'
        with self.assertRaisesRegex(AssertionError,'manager-phase'):self.check()
    def test_missing_unit_is_not_graceful(self):
        self.i={}
        with self.assertRaises(KeyError):self.check()


class SavedDeath(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.g=funcs('client-operations.py',{'contextlib':contextlib,'P':lambda q:self.root/str(q).lstrip('/')})
        self.pid=self.root/'proc/10';self.pid.mkdir(parents=True)
        fields=['0']*40;fields[19]='99';(self.pid/'stat').write_text('10 (fixture) '+' '.join(fields))
        self.cg=self.root/'sys/fs/cgroup/owned';self.cg.mkdir(parents=True);(self.cg/'cgroup.procs').write_text('')
        st=self.cg.stat();self.info={'diagnosticIdentity':{'bound':True,'pid':10,'startTicks':99,'controlGroup':'/owned'},'cgroupIdentity':[st.st_dev,st.st_ino]}
    def tearDown(self):self.tmp.cleanup()
    def test_original_pid_blocks_even_without_receipt(self):
        with self.assertRaisesRegex(AssertionError,'still-alive'):self.g['saved_client_dead'](self.info)
    def test_descendant_blocks_after_main_gone(self):
        (self.pid/'stat').unlink();(self.cg/'cgroup.procs').write_text('123\n')
        with self.assertRaisesRegex(AssertionError,'descendants-live'):self.g['saved_client_dead'](self.info)
    def test_replaced_cgroup_is_not_accepted(self):
        (self.pid/'stat').unlink();self.info['cgroupIdentity'][1]+=1
        with self.assertRaisesRegex(AssertionError,'replaced'):self.g['saved_client_dead'](self.info)
    def test_actual_saved_death_without_unit_receipt(self):
        (self.pid/'stat').unlink();self.assertTrue(self.g['saved_client_dead'](self.info))

class AtomicPublication(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.root.chmod(0o700)
        # Exercise actual file/link/fsync operations; UID metadata alone is mocked.
        def rootstat(fd):
            values=list(os.fstat(fd));values[4]=0;return os.stat_result(values)
        proxy=types.SimpleNamespace(**{n:getattr(os,n) for n in dir(os) if not n.startswith('__')});proxy.fstat=rootstat
        self.g=funcs('exit-recorder.py',{'os':proxy})
    def tearDown(self):self.tmp.cleanup()
    def test_complete_publication_and_no_overwrite(self):
        self.g['publish_json'](self.root,'receipt.json',{'value':1})
        with self.assertRaises(FileExistsError):self.g['publish_json'](self.root,'receipt.json',{'value':2})
        self.assertEqual(json.loads((self.root/'receipt.json').read_text()),{'value':1})
        self.assertEqual([x.name for x in self.root.iterdir()],['receipt.json'])
    def test_sync_failure_before_link_exposes_no_final(self):
        self.g['os'].fsync=lambda fd:(_ for _ in ()).throw(OSError('fixture'))
        with self.assertRaises(OSError):self.g['publish_json'](self.root,'receipt.json',{'value':1})
        self.assertFalse((self.root/'receipt.json').exists())

if __name__=='__main__':unittest.main()

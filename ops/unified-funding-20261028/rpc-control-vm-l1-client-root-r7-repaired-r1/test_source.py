"""Source fixtures only. Root executes; no SSH, COW/image access or client launch."""
import unittest,ast,json,types,copy,os,stat,hashlib,struct,fcntl,re,time
from pathlib import Path
p=Path(__file__).resolve().parent;s=p/'source'

def funcs(name,extra=None):
    tree=ast.parse((s/name).read_text());g={'os':os,'stat':stat,'hashlib':hashlib,'struct':struct,'fcntl':fcntl,'Path':Path,'time':time,'json':json,'re':re}
    g.update(extra or {});exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef)],type_ignores=[]),'fixture:'+name,'exec'),g);return g

class Chain(unittest.TestCase):
 def setUp(self):
  self.g=funcs('backing-policy.py');m=json.loads((s/'MANIFEST.json').read_text())
  self.chain=json.loads(Path(m['frozenChainEvidence']['path']).read_text());self.paths=[e['filename'] for e in self.chain];self.size=4000000000000
 def check(self):return self.g['validate_backing_chain'](self.chain,self.paths,self.size)
 def test_exact_frozen_chain(self):self.assertTrue(self.check())
 def test_exact_new_child_chain(self):
  child=copy.deepcopy(self.chain[0]);child['filename']='/fixture/new-child.qcow2';child['children'][0]['info']['filename']=child['filename'];child['backing-filename']=child['full-backing-filename']=self.paths[0]
  self.chain.insert(0,child);self.paths.insert(0,child['filename']);self.assertTrue(self.check())
 def test_unexpected_ancestor(self):
  self.chain.append(copy.deepcopy(self.chain[-1]))
  with self.assertRaisesRegex(AssertionError,'length'):self.check()
 def test_wrong_backing(self):
  self.chain[0]['backing-filename']='/wrong'
  with self.assertRaisesRegex(AssertionError,'path-mismatch'):self.check()
 def test_relative_backing(self):
  self.chain[0]['backing-filename']='relative.qcow2'
  with self.assertRaisesRegex(AssertionError,'path-mismatch'):self.check()
 def test_wrong_virtual_size(self):
  self.chain[0]['virtual-size']=1
  with self.assertRaisesRegex(AssertionError,'identity'):self.check()
 def test_external_data(self):
  self.chain[0]['format-specific']['data']['data-file']='/outside'
  with self.assertRaisesRegex(AssertionError,'external'):self.check()
 def test_external_child(self):
  self.chain[0]['children'][0]['info']['filename']='/outside'
  with self.assertRaisesRegex(AssertionError,'external'):self.check()
 def test_dirty(self):
  self.chain[0]['dirty-flag']=True
  with self.assertRaisesRegex(AssertionError,'dirty'):self.check()
 def test_corrupt(self):
  self.chain[0]['format-specific']['data']['corrupt']=True
  with self.assertRaisesRegex(AssertionError,'corrupt'):self.check()
 def test_encrypted(self):
  self.chain[0]['encrypted']=True
  with self.assertRaisesRegex(AssertionError,'encrypted'):self.check()

class FrozenReceipt(unittest.TestCase):
 def setUp(self):
  self.m=json.loads((s/'MANIFEST.json').read_text());self.r=json.loads(Path(self.m['frozenBackingEvidence']['path']).read_text());self.g=funcs('backing-policy.py')
 def check(self):return self.g['validate_frozen_receipt'](self.r,self.m)
 def test_exact_full_hash_receipt(self):self.check()
 def test_wrong_hash(self):
  self.r['sha256']='0'*64
  with self.assertRaisesRegex(AssertionError,'content-pin'):self.check()
 def test_missing_full_hash(self):
  del self.m['frozenBacking']['sha256']
  with self.assertRaises(KeyError):self.check()
 def test_wrong_inode(self):
  self.r['identity']['st_ino']+=1
  with self.assertRaisesRegex(AssertionError,'identity'):self.check()
 def test_hash_without_locks(self):
  self.r['qemuCompatibleLocksHeldDuringHash']=False
  with self.assertRaisesRegex(AssertionError,'policy'):self.check()
 def test_untrusted_parent_receipt(self):
  self.r['parents']={}
  with self.assertRaisesRegex(AssertionError,'parent-evidence'):self.check()
 def test_symlink_type(self):
  self.m['frozenBacking']['mode']=self.r['identity']['st_mode']=stat.S_IFLNK|0o600
  with self.assertRaisesRegex(AssertionError,'file-policy'):self.check()
 def test_multiple_links(self):
  self.m['frozenBacking']['links']=self.r['identity']['st_nlink']=2
  with self.assertRaisesRegex(AssertionError,'file-policy'):self.check()

class Locks(unittest.TestCase):
 def test_two_independent_readonly_denial_lock_sets(self):
  calls=[];opened=[]
  def op(path,flags):opened.append((path,flags));return 70+len(opened)
  def fc(fd,action,data):
   calls.append((fd,action,struct.unpack('@hhqqi4x',data)))
   return struct.pack('@hhqqi4x',fcntl.F_UNLCK,os.SEEK_SET,100,200,0)
  proxy=types.SimpleNamespace(open=op,O_RDONLY=os.O_RDONLY,O_NOFOLLOW=os.O_NOFOLLOW,O_CLOEXEC=os.O_CLOEXEC,SEEK_SET=os.SEEK_SET)
  fp=types.SimpleNamespace(fcntl=fc,F_OFD_SETLK=fcntl.F_OFD_SETLK,F_OFD_GETLK=fcntl.F_OFD_GETLK,F_RDLCK=fcntl.F_RDLCK,F_WRLCK=fcntl.F_WRLCK,F_UNLCK=fcntl.F_UNLCK)
  g=funcs('backing-policy.py',{'os':proxy,'fcntl':fp});g['backing_identity']=lambda *a:None;g['backing_header']=lambda *a:None;held=[]
  for path in ('/original','/frozen'):g['lock_backing']({'path':path},held)
  self.assertEqual(len(held),2);self.assertEqual(len(calls),8)
  for fd in (71,72):self.assertEqual([c[2][2] for c in calls if c[0]==fd],[201,202,203,100])
  for _,flags in opened:self.assertEqual(flags,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
 def test_conflict_keeps_fd_registered_for_cleanup(self):
  g=funcs('backing-policy.py');held=[];g['backing_identity']=lambda *a:None;g['backing_header']=lambda *a:None
  proxy=types.SimpleNamespace(open=lambda *a:77,O_RDONLY=os.O_RDONLY,O_NOFOLLOW=os.O_NOFOLLOW,O_CLOEXEC=os.O_CLOEXEC,SEEK_SET=os.SEEK_SET)
  def fc(fd,action,data):return struct.pack('@hhqqi4x',fcntl.F_WRLCK,os.SEEK_SET,100,200,0)
  g['os']=proxy;g['fcntl']=types.SimpleNamespace(fcntl=fc,F_OFD_SETLK=fcntl.F_OFD_SETLK,F_OFD_GETLK=fcntl.F_OFD_GETLK,F_RDLCK=fcntl.F_RDLCK,F_WRLCK=fcntl.F_WRLCK,F_UNLCK=fcntl.F_UNLCK)
  with self.assertRaisesRegex(AssertionError,'writer-conflict'):g['lock_backing']({'path':'/frozen'},held)
  self.assertEqual(held,[({'path':'/frozen'},77)])

class Progress(unittest.TestCase):
 def setUp(self):
  self.g=funcs('recovery-progress.py');self.c=self.g['recovery_clock'](0)
  self.d={'sameIncarnation':True,'identity':{'pid':1,'startTicks':10,'invocationID':'a'*32,'procIdentity':[1,2]},'io':{'read_bytes':0,'write_bytes':0},'stat':{'userTicks':0,'systemTicks':0}}
  self.marker=('Starting unwind','MerkleUnwind',(('from',30),('to',0)))
 def step(self,t,markers=()):return self.g['advance_recovery'](self.c,t,self.d,markers)
 def test_203_second_phase_allowed(self):self.step(0,[self.marker]);self.assertIsNone(self.step(203))
 def test_no_work_300_boundary(self):self.step(0);self.assertIsNone(self.step(299));self.assertEqual(self.step(300),'recovery-no-work-limit')
 def test_io_does_not_extend_600_semantic_limit(self):
  self.step(0,[self.marker]);self.d['io']['read_bytes']=10;self.step(299);self.d['io']['read_bytes']=20
  self.assertEqual(self.step(600,[self.marker]),'recovery-semantic-progress-limit')
 def test_semantic_marker_once(self):
  self.step(0,[self.marker]);self.step(200,[self.marker]);self.assertEqual(self.c['lastSemantic'],0)
 def test_new_semantic_marker(self):
  self.step(0,[self.marker]);self.step(200,[('Starting unwind','Finish',())]);self.assertEqual(self.c['lastSemantic'],200)
 def test_io_advances_work(self):self.step(0);self.d['io']['read_bytes']=1;self.step(200);self.assertEqual(self.c['lastWork'],200)
 def test_cpu_advances_work(self):self.step(0);self.d['stat']['userTicks']=1;self.step(200);self.assertEqual(self.c['lastWork'],200)
 def test_counter_reset_refused(self):
  self.d['io']['read_bytes']=10;self.step(0);self.d['io']['read_bytes']=1
  with self.assertRaisesRegex(AssertionError,'counter-reset'):self.step(1)
 def test_pid_reuse_refused(self):
  self.step(0);self.d['identity']['startTicks']=11
  with self.assertRaisesRegex(AssertionError,'incarnation'):self.step(1)
 def test_invalid_sample_does_not_refresh(self):
  self.step(0);self.d={'sameIncarnation':False};self.assertEqual(self.step(300,[self.marker]),'recovery-no-work-limit')
 def test_900_absolute_limit(self):
  self.c['lastSemantic']=899;self.c['lastWork']=899;self.assertEqual(self.g['recovery_stop_reason'](self.c,900),'recovery-window-ended')
 def test_timestamps_not_progress(self):
  one=json.dumps({'MESSAGE':'time1 Starting unwind stage=MerkleUnwind from=30 to=0','_SYSTEMD_INVOCATION_ID':'a'*32})
  two=one.replace('time1','time2');self.assertEqual(self.g['recovery_markers'](one,'a'*32),self.g['recovery_markers'](two,'a'*32))
 def test_foreign_journal_refused(self):
  row=json.dumps({'MESSAGE':'Opening database','_SYSTEMD_INVOCATION_ID':'b'*32})
  with self.assertRaisesRegex(AssertionError,'invocation'):self.g['recovery_markers'](row,'a'*32)
 def test_unrecognized_sensitive_log_not_emitted(self):
  row=json.dumps({'MESSAGE':'arbitrary fixture secret content','_SYSTEMD_INVOCATION_ID':'a'*32});self.assertEqual(self.g['recovery_markers'](row,'a'*32),[])

class Source(unittest.TestCase):
 def test_parse_all(self):
  for q in s.glob('*.py'):ast.parse(q.read_text(),filename=str(q))
 def test_no_toml_rewrite(self):
  t=(s/'client-main.py').read_text();self.assertNotIn('os.replace(temporary,config)',t);self.assertNotIn('trial-new',t);self.assertIn("M['proposedTomlSha256']",t)
 def test_no_original_child_fallback(self):
  t=(s/'run-body.py').read_text();self.assertIn("'-b',M['recoveryBackingPath'],str(overlay)",t);self.assertNotIn("'-b',str(parent)",t)
 def test_timing_envelope(self):
  m=json.loads((s/'MANIFEST.json').read_text());v=m['timingPolicy'];self.assertEqual(v['outerSeconds'],1800);self.assertEqual(v['sampleWindowSeconds'],900)
  self.assertEqual(v['preparationSeconds']+v['mainCaptureSeconds']+v['verifyCaptureSeconds']+v['requestStopCaptureSeconds']+v['socketClearCaptureSeconds']+v['localReapReserveSeconds']+v['finalFrozenHashReserveSeconds']+v['finalChainCheckSeconds'],1695)
  self.assertLess(v['nominalSequentialBoundSeconds'],v['outerSeconds'])
 def test_cleanup_and_both_backings_final(self):
  t=(s/'run-body.py').read_text();self.assertLess(t.index("value=remote('verify')"),t.index("results['frozenBackingHashAfter']"));self.assertIn('for row,fd in reversed(backing_locks):os.close(fd)',t)
 def test_evidence_cap(self):
  t=(s/'client-main.py').read_text();self.assertIn('evidence_bytes+encoded<=1048576',t);self.assertIn('diagnostic_count<91',t)

if __name__=='__main__':unittest.main(verbosity=2)

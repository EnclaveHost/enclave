"""Local metadata fixtures only; no SSH, client, systemd, NBD or production paths."""
import unittest,importlib.util,tempfile,os,stat,sys,ast,json,types,urllib.request,urllib.error,time
from pathlib import Path
p=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('ownership',p/'source/ownership.py');own=importlib.util.module_from_spec(spec);spec.loader.exec_module(own)
class Ownership(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='nan-owner-fixture-');self.root=Path(self.tmp.name)
  for n in ('cl','tmp-cl'):(self.root/n).mkdir(mode=0o750)
  (self.root/'cl/data').write_bytes(b'preserved');(self.root/'cl/data').chmod(0o640)
  self.ids=(os.getuid(),os.getgid())
 def tearDown(self):self.tmp.cleanup()
 def scan(self,**kw):return own.remap_tree(str(self.root),self.ids,self.ids,**kw)
 def test_metadata_roundtrip(self):
  before=self.scan();after=self.scan(ledger=before);self.assertEqual(before,after);self.assertEqual((self.root/'cl/data').read_bytes(),b'preserved')
 def test_symlink(self):
  (self.root/'cl/link').symlink_to('/etc/passwd')
  with self.assertRaisesRegex(RuntimeError,'file-type'):self.scan()
 def test_fifo_rejected_before_open(self):
  os.mkfifo(self.root/'cl/pipe')
  with self.assertRaisesRegex(RuntimeError,'file-type'):self.scan()
 def test_hardlink(self):
  os.link(self.root/'cl/data',self.root/'tmp-cl/link')
  with self.assertRaisesRegex(RuntimeError,'hardlink'):self.scan()
 def test_privilege_bits(self):
  (self.root/'cl/data').chmod(0o4640)
  with self.assertRaisesRegex(RuntimeError,'privilege'):self.scan()
 def test_drift_before_write(self):
  ledger=self.scan();(self.root/'cl/data').write_bytes(b'different')
  with self.assertRaisesRegex(RuntimeError,'preflight-drift'):self.scan(ledger=ledger)
 def test_unknown_uid(self):
  with self.assertRaisesRegex(RuntimeError,'source-identity'):own.remap_tree(str(self.root),(self.ids[0]+1,self.ids[1]),self.ids)
 def test_stop_request(self):
  def stop():raise RuntimeError('latched-stop')
  with self.assertRaisesRegex(RuntimeError,'latched-stop'):self.scan(tick=stop)
 def test_time_bound(self):
  with self.assertRaisesRegex(RuntimeError,'time-bound'):self.scan(seconds=0)
 def test_depth(self):
  q=self.root/'cl'
  for _ in range(34):q=q/'x';q.mkdir(mode=0o750)
  with self.assertRaisesRegex(RuntimeError,'depth'):self.scan()
class Source(unittest.TestCase):
 def test_all_sources_parse(self):
  for q in (p/'source').glob('*.py'):ast.parse(q.read_text(),filename=str(q))
 def test_source_mount_consistency(self):
  s=p/'source';m=json.loads((s/'MANIFEST.json').read_text());a=json.loads((s/'payload-manifest.json').read_text());d=json.loads((s/'disks.json').read_text())
  self.assertEqual(m['expectedProductionMount'],a['mounts']['l1']);self.assertEqual(d['disks'][0]['mount'],a['mounts']['l1']);self.assertFalse(m['admission']['authorized']);self.assertEqual(m['client']['path'],m['uploadDirectory']+'/nbd-client')
 def test_no_el_in_client_path(self):
  s=p/'source';m=json.loads((s/'MANIFEST.json').read_text());self.assertNotIn('reth',m['payloadFiles']);t=(s/'client-main.py').read_text();self.assertNotIn('os.replace(temporary,config)',t);self.assertIn("for side in ('cl',):",t)
 def test_cl_rpc_singleton(self):
  tree=ast.parse((p/'source/client-operations.py').read_text());fn=next(x for x in tree.body if isinstance(x,ast.FunctionDef) and x.name=='sample_rpc')
  class Response:
   def __enter__(self):return self
   def __exit__(self,*a):pass
   def read(self,n):return b'{"data":{"is_syncing":true,"el_offline":true}}'
  request=types.SimpleNamespace(Request=lambda *a:None,urlopen=lambda *a,**kw:Response())
  g={'json':json,'urllib':types.SimpleNamespace(request=request)};exec(compile(ast.Module(body=[fn],type_ignores=[]),'sample-rpc-fixture','exec'),g)
  self.assertEqual(g['sample_rpc'](),{'cl':{'data':{'is_syncing':True,'el_offline':True}}})
 def test_memory_floor_includes_remaining_and_pending(self):
  tree=ast.parse((p/'source/nan-admission.py').read_text());fn=next(x for x in tree.body if isinstance(x,ast.FunctionDef) and x.name=='nan_headroom')
  available=[6410]
  class Fake:
   def __init__(self,n):self.n=str(n)
   def __truediv__(self,n):return Fake(self.n+'/'+n)
   def read_text(self):return 'MemAvailable: '+str(available[0]*1024)+' kB\n'
   def exists(self):return False
  g={'P':Fake,'cleaning':False,'ACTION':'main','last_guard':0,'time':types.SimpleNamespace(monotonic=lambda:10),'fresh_nan_policy':lambda:None,'M':{'admission':{'observedPendingMiB':10},'ownedSlices':['a','b','c']},'out':{}}
  exec(compile(ast.Module(body=[fn],type_ignores=[]),'floor-fixture','exec'),g)
  g['nan_headroom']();self.assertEqual(g['out']['lastHeadroom']['residual'],2048<<20)
  g['last_guard']=0;available[0]=6409
  with self.assertRaisesRegex(AssertionError,'residual'):g['nan_headroom']()
class Admission(unittest.TestCase):
 def load(self,names,extra=None):
  tree=ast.parse((p/'source/nan-admission.py').read_text());g=dict(extra or {})
  exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names],type_ignores=[]),'admission-fixture','exec'),g);return g
 def row(self,h):return [['test.timer','test.service'],['Fri','2026-10-30',h,'UTC']]
 def check(self,new,old):
  import datetime
  horizon=datetime.datetime(2026,10,30,15,10,tzinfo=datetime.timezone.utc).timestamp()
  self.load(['timer_window'])['timer_window'](new,old,horizon)
 def test_randomized_future_timer_allowed(self):self.check([self.row('23:03:29')],[self.row('23:56:16')])
 def test_work_entering_window_refused(self):
  with self.assertRaisesRegex(AssertionError,'entered'):self.check([self.row('15:05:00')],[self.row('23:56:16')])
 def test_inactive_timer_becomes_due_refused(self):
  with self.assertRaisesRegex(AssertionError,'entered'):self.check([self.row('15:05:00')],[[['test.timer','test.service'],['-']]])
 def test_changed_target_refused(self):
  row=self.row('23:00:00');row[0][1]='another.service'
  with self.assertRaisesRegex(AssertionError,'target'):self.check([row],[self.row('23:56:16')])
 def test_due_work_already_reserved_allowed(self):self.check([self.row('15:09:00')],[self.row('15:00:00')])
 def test_due_work_recedes_allowed(self):self.check([self.row('23:00:00')],[self.row('15:00:00')])
 def test_guard_reason_retained(self):
  def fail():raise AssertionError('timer-work-entered-admitted-window')
  g=self.load(['checked_headroom'],{'nan_headroom':fail,'out':{}})
  with self.assertRaises(AssertionError):g['checked_headroom']()
  self.assertEqual(g['out']['guardFailure']['message'],'timer-work-entered-admitted-window')
 def test_partial_seal_has_durable_identity(self):
  tree=ast.parse((p/'source/client-main.py').read_text());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='seal_payload')
  with tempfile.TemporaryDirectory() as td:
   root=Path(td)/'exec';payload=root/'payload';saved=[];current={'execIdentity':None}
   def save(s):
    self.assertEqual(stat.S_IMODE(root.stat().st_mode),0o755)
    saved.append(dict(s))
   def fail():raise RuntimeError('fixture-stop')
   class StopMap(dict):
    def items(self):fail()
   g={'EXEC':root,'PAYLOAD':payload,'state':lambda:current,'save':save,'M':{'payloadFiles':StopMap()}}
   exec(compile(ast.Module(body=[fn],type_ignores=[]),'seal-fixture','exec'),g)
   old=os.umask(0o077)
   try:
    with self.assertRaisesRegex(RuntimeError,'fixture-stop'):g['seal_payload']()
   finally:os.umask(old)
   self.assertEqual(stat.S_IMODE(root.stat().st_mode),0o755)
   self.assertEqual(saved[0]['execIdentity'],[root.stat().st_dev,root.stat().st_ino])
if __name__=='__main__':unittest.main(verbosity=2)

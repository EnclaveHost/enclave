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
   g={'EXEC':root,'PAYLOAD':payload,'state':lambda:current,'save':save,'M':{'payloadFiles':StopMap(),'remoteBinaryReuse':{'name':'lighthouse'}}}
   exec(compile(ast.Module(body=[fn],type_ignores=[]),'seal-fixture','exec'),g)
   old=os.umask(0o077)
   try:
    with self.assertRaisesRegex(RuntimeError,'fixture-stop'):g['seal_payload']()
   finally:os.umask(old)
   self.assertEqual(stat.S_IMODE(root.stat().st_mode),0o755)
   self.assertEqual(saved[0]['execIdentity'],[root.stat().st_dev,root.stat().st_ino])
class Ext4Identity(unittest.TestCase):
 def setUp(self):
  import struct,uuid
  tree=ast.parse((p/'source/client-main.py').read_text());code=ast.literal_eval(next(n.value for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(z,ast.Name) and z.id=='EXT4_IDENTITY_PROBE' for z in n.targets)))
  ast.parse(code);inner=ast.parse(code);fn=[n for n in inner.body if isinstance(n,ast.FunctionDef)];g={'struct':struct,'uuid':uuid};exec(compile(ast.Module(body=fn,type_ignores=[]),'ext4-fixture','exec'),g);self.decode=g['decode_superblock'];self.crc=g['crc32c'];self.ident='a2f2a8b5-06ac-4612-95a0-f48a00a7f6e0';self.raw=bytearray(4096)
  struct.pack_into('<H',self.raw,1024+0x38,0xef53);struct.pack_into('<H',self.raw,1024+0x3a,1);self.raw[1024+0x68:1024+0x78]=uuid.UUID(self.ident).bytes
  self.code=code
 def test_exact_uuid_bytes(self):self.assertEqual(self.decode(bytes(self.raw),self.ident)['uuid'],self.ident)
 def test_short_read(self):
  with self.assertRaisesRegex(AssertionError,'short'):self.decode(bytes(self.raw[:-1]),self.ident)
 def test_magic(self):
  self.raw[1024+0x38]=0
  with self.assertRaisesRegex(AssertionError,'magic'):self.decode(bytes(self.raw),self.ident)
 def test_wrong_uuid(self):
  with self.assertRaisesRegex(AssertionError,'uuid'):self.decode(bytes(self.raw),'00000000-0000-0000-0000-000000000000')
 def test_recovery_required(self):
  self.raw[1024+0x60]=4
  with self.assertRaisesRegex(AssertionError,'recovery'):self.decode(bytes(self.raw),self.ident)
 def test_error_flag(self):
  self.raw[1024+0x3a]=3
  with self.assertRaisesRegex(AssertionError,'recovery'):self.decode(bytes(self.raw),self.ident)
 def test_orphan_state_refused(self):
  self.raw[1024+0x3a]=5
  with self.assertRaisesRegex(AssertionError,'recovery'):self.decode(bytes(self.raw),self.ident)
 def test_orphan_present_refused(self):
  import struct
  struct.pack_into('<I',self.raw,1024+0x64,0x10000)
  with self.assertRaisesRegex(AssertionError,'recovery'):self.decode(bytes(self.raw),self.ident)
 def test_crc32c_standard_vector(self):self.assertEqual(self.crc(b'123456789'),0x1cf96d7c)
 def checksum_fixture(self):
  import struct
  struct.pack_into('<I',self.raw,1024+0x64,0x400);self.raw[1024+0x175]=1
  struct.pack_into('<I',self.raw,1024+0x3fc,self.crc(self.raw[1024:1024+0x3fc]))
 def test_checksum_pass(self):
  self.checksum_fixture();self.assertEqual(self.decode(bytes(self.raw),self.ident)['uuid'],self.ident)
 def test_checksum_corruption(self):
  self.checksum_fixture();self.raw[1024+20]^=1
  with self.assertRaisesRegex(AssertionError,'checksum'):self.decode(bytes(self.raw),self.ident)
 def test_checksum_unknown_type(self):
  self.checksum_fixture();self.raw[1024+0x175]=2
  with self.assertRaisesRegex(AssertionError,'checksum-type'):self.decode(bytes(self.raw),self.ident)
 def test_single_bounded_read_and_no_fallback(self):
  tree=ast.parse(self.code);reads=[n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr=='preadv'];self.assertEqual(len(reads),1);self.assertIn('os.O_NOFOLLOW|os.O_DIRECT',self.code);self.assertNotIn('except',self.code)
class IdmapSource(unittest.TestCase):
 def test_actual_mapping_and_no_inode_rewrite(self):
  m=json.loads((p/'source/MANIFEST.json').read_text());self.assertEqual(m['idmapOptions'],'u:995:50011:1 g:986:50011:1')
  tree=ast.parse((p/'source/client-main.py').read_text());main=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='main_trial')
  self.assertFalse(any(isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='remap_tree' for n in ast.walk(main)))
 def test_confinement_and_raw_exposure_order(self):
  t=(p/'source/client-main.py').read_text();self.assertLess(t.index('CL-mapped-directory-identity'),t.index('MOUNT.parent.chmod(0o710)'));self.assertIn('rw,nosuid,nodev,noexec,nosymfollow,X-mount.idmap=',t)
  t=(p/'source/client-operations.py').read_text()
  for value in ('NoNewPrivileges=yes','ProtectSystem=strict','ProtectHome=yes','InaccessiblePaths=','ReadWritePaths='):self.assertIn(value,t)
class ClientMountBinding(unittest.TestCase):
 def setUp(self):
  from unittest.mock import Mock
  self.row={'target':'/mount/cl','maj:min':'43:224','fstype':'ext4','fsroot':'/cl','vfs-options':'rw,nosuid,nodev,noexec,nosymfollow'}
  self.st=types.SimpleNamespace(st_mode=stat.S_IFDIR|0o750,st_dev=os.makedev(43,224),st_ino=123,st_uid=50011,st_gid=50011)
  self.receipt={'device':'43:224','directories':{'cl':{'dev':self.st.st_dev,'ino':123}}}
  tree=ast.parse((p/'source/trial-chain-service.py').read_text());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='mounted_identity')
  self.g={'json':json,'stat':stat,'os':types.SimpleNamespace(stat=lambda *a,**k:self.st,major=os.major,minor=os.minor),'subprocess':types.SimpleNamespace(check_output=lambda *a,**k:json.dumps({'filesystems':[self.row]}))}
  exec(compile(ast.Module(body=[fn],type_ignores=[]),'mount-binding-fixture','exec'),self.g)
 def check(self):self.g['mounted_identity']('/mount','/mount/cl','/cl',self.receipt)
 def test_valid_without_uuid_cache(self):self.check()
 def test_device_mismatch(self):
  self.row['maj:min']='43:225'
  with self.assertRaisesRegex(AssertionError,'mount-device'):self.check()
 def test_wrong_subtree(self):
  self.row['fsroot']='/foreign'
  with self.assertRaisesRegex(AssertionError,'mount-device'):self.check()
 def test_replaced_inode(self):
  self.st.st_ino=124
  with self.assertRaisesRegex(AssertionError,'directory-identity'):self.check()
 def test_symlink_not_directory(self):
  self.st.st_mode=stat.S_IFLNK|0o777
  with self.assertRaisesRegex(AssertionError,'directory-identity'):self.check()
 def test_readonly_data(self):
  self.row['vfs-options']='ro,nosuid,nodev,noexec,nosymfollow'
  with self.assertRaisesRegex(AssertionError,'write-policy'):self.check()
 def test_missing_nosymfollow(self):
  self.row['vfs-options']='rw,nosuid,nodev,noexec'
  with self.assertRaisesRegex(AssertionError,'confinement'):self.check()
 def test_wrong_visible_owner(self):
  self.st.st_uid=995
  with self.assertRaisesRegex(AssertionError,'mapped-owner'):self.check()
 def test_receipt_nonce_and_authority_present(self):
  t=(p/'source/trial-chain-service.py').read_text()
  for x in ('os.O_NOFOLLOW','receipt-parent-authority','receipt-authority',"receipt['nonce']==MANIFEST['trialMountNonce']",'receipt-freshness','receipt-superblock-proof',"for rel in ('cl','tmp-cl')"):
   self.assertIn(x,t)
class RetainedBinary(unittest.TestCase):
 def setUp(self):
  import hashlib
  self.tmp=tempfile.TemporaryDirectory(prefix='retained-public-binary-');self.root=Path(self.tmp.name);self.source=self.root/'source';self.target=self.root/'copy';self.source.write_bytes(b'public fixture binary');self.source.chmod(0o755)
  self.expected={'name':'lighthouse','source':str(self.source),'bytes':self.source.stat().st_size,'sha256':hashlib.sha256(self.source.read_bytes()).hexdigest()}
  self.foreign=False;self.changed_parent=False;self.parent_calls=0
  def mapped(st,is_parent=False):
   v={k:getattr(st,k) for k in ('st_dev','st_ino','st_size','st_uid','st_gid','st_mode','st_nlink','st_mtime_ns','st_ctime_ns')};v['st_uid']=1 if self.foreign else 0
   if is_parent:
    self.parent_calls+=1
    if self.changed_parent and self.parent_calls>1:v['st_ino']+=1
   return types.SimpleNamespace(**v)
  self.mapped=mapped;outer=self
  class FixturePath:
   def __init__(self,value):self.path=Path(value)
   def __fspath__(self):return str(self.path)
   def __str__(self):return str(self.path)
   @property
   def parents(self):return [FixturePath(outer.root)]
   def lstat(self):return mapped(self.path.lstat(),self.path==outer.root)
  fn=next(n for n in ast.parse((p/'source/client-main.py').read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='copy_retained_lighthouse')
  assignment=next(n for n in fn.body if isinstance(n,ast.Assign) and any(isinstance(v,ast.Name) and v.id=='expected' for v in n.targets));assignment.value=ast.parse(repr(self.expected),mode='eval').body;ast.fix_missing_locations(fn)
  proxy=types.SimpleNamespace(**{n:getattr(os,n) for n in ('open','O_RDONLY','O_NOFOLLOW','O_CLOEXEC','fdopen','fsync','close')});proxy.fstat=lambda fd:mapped(os.fstat(fd))
  self.g={'P':FixturePath,'M':{'remoteBinaryReuse':dict(self.expected)},'stat':stat,'os':proxy,'hashlib':hashlib,'headroom':lambda:None,'sha':lambda q:hashlib.sha256(q.read_bytes()).hexdigest(),'out':{}}
  exec(compile(ast.Module(body=[fn],type_ignores=[]),'retained-public-byte-fixture','exec'),self.g)
  self.row={'destination':'bin/lighthouse','bytes':self.expected['bytes'],'sha256':self.expected['sha256']}
 def tearDown(self):self.tmp.cleanup()
 def copy(self):self.g['copy_retained_lighthouse'](self.row,self.target)
 def test_real_fd_copy_same_bytes(self):self.copy();self.assertEqual(self.target.read_bytes(),self.source.read_bytes())
 def test_wrong_policy(self):
  self.g['M']['remoteBinaryReuse']['name']='other'
  with self.assertRaisesRegex(AssertionError,'policy'):self.copy()
 def test_foreign_owner(self):
  self.foreign=True
  with self.assertRaisesRegex(AssertionError,'authority'):self.copy()
 def test_writable_file(self):
  self.source.chmod(0o777)
  with self.assertRaisesRegex(AssertionError,'authority'):self.copy()
 def test_hardlink(self):
  os.link(self.source,self.root/'alias')
  with self.assertRaisesRegex(AssertionError,'authority'):self.copy()
 def test_symlink(self):
  self.source.rename(self.root/'real');self.source.symlink_to(self.root/'real')
  with self.assertRaisesRegex(AssertionError,'authority'):self.copy()
 def test_wrong_size(self):
  self.source.write_bytes(b'bad')
  with self.assertRaisesRegex(AssertionError,'authority'):self.copy()
 def test_wrong_hash(self):
  self.source.write_bytes(b'X'*self.expected['bytes'])
  with self.assertRaisesRegex(AssertionError,'hash'):self.copy()
 def test_parent_replaced(self):
  self.changed_parent=True
  with self.assertRaisesRegex(AssertionError,'parent-drift'):self.copy()
 def test_target_exists(self):
  self.target.write_bytes(b'keep')
  with self.assertRaises(FileExistsError):self.copy()
  self.assertEqual(self.target.read_bytes(),b'keep')
if __name__=='__main__':unittest.main(verbosity=2)


"""Exact transported bootstrap + seeded imports in a disposable root namespace.

SSH/systemd are mocked. File custody, durable intent and /proc/pidfd observations
are real; these fixtures do not qualify a live guest or storage attachment.
"""
import importlib.util,io,json,os,shlex,shutil,subprocess,sys,time,unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
 s=importlib.util.spec_from_file_location(name,ROOT/path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
fixture=load('delivery_fixture','test/rpc-guest/test_deliver_activation.py')
x=load('activation_launch','rpc/launch_activation.py');put=fixture.put;p=x.p
class Tests(unittest.TestCase):
 def setUp(self):
  self.f=fixture.Tests('test_owner_package_to_actual_receiver_to_activation_stage');self.f.setUp();self.c=self.f.c
  with patch.object(fixture.d,'exchange',self.f.exchange):fixture.d.send(self.f.config)
  self.config=dict(self.f.config);self.config['attachmentReceipt']=self.config.pop('bundleReceipt')
  path=Path('/work/journal')/self.c['attempt']/'receipt.json'
  self.config['deliveryReceipt']={'path':str(path),'sha256':p.sha(path.read_bytes())}
  folder=Path('/var/lib/enclave-rpc-activation-launch')
  if folder.exists():shutil.rmtree(folder)
  folder.mkdir(mode=0o700)
  self.calls=[];self.started=False;self.start_count=0;self.change=lambda unit,row:None;self.start_failure=False
 def systemctl(self,argv,**kwargs):
  self.assertEqual(argv[0],'/usr/bin/systemctl')
  if argv[1]=='show':
   unit=argv[2];row=self.f.f.unit(active=self.started)
   if unit.startswith('enclave-rpc-activation-launch-'):
    row.update(Id=unit,Type='exec',RuntimeMaxUSec='10s',MemoryMax=str(64<<20),MainPID=str(os.getpid()),ActiveState='active')
   elif unit==fixture.a.UNIT:
    row.update(MainPID=str(os.getpid())if self.started else'0',InvocationID='34'*16 if self.started else'56'*16,WatchdogTimestampMonotonic=str(time.monotonic_ns()//1000))
   else:raise AssertionError('Unexpected unit')
   self.change(unit,row)
   return SimpleNamespace(returncode=0,stdout=('\n'.join(k+'='+v for k,v in row.items())+'\n').encode(),stderr=b'')
  self.assertEqual(argv[1:],['--no-block','--job-mode=fail','start',fixture.a.UNIT])
  state=Path('/var/lib/enclave-rpc-activation-launch')/self.c['attempt']
  self.assertTrue((state/'intent.json').is_file());self.assertFalse((state/'receipt.json').exists())
  self.start_count+=1;self.started=True
  return SimpleNamespace(returncode=1 if self.start_failure else 0,stdout=b'',stderr=b'')
 def bootstrap(self,raw=None,argv=None,stdin=None):
  supplied,c,_,pins=x.package(self.config,time.time_ns());raw=supplied if raw is None else raw
  remote=x.remote_command(c,supplied,pins);args=['bootstrap',*remote[remote.index('-c')+2:]] if argv is None else argv
  out=io.StringIO()
  with patch.object(subprocess,'run',self.systemctl),patch.object(sys,'argv',args),patch.object(sys,'stdin',SimpleNamespace(buffer=io.BytesIO(raw)if stdin is None else stdin)),redirect_stdout(out):
   exec(compile(x.BOOTSTRAP,'<exact-launch-bootstrap>','exec'),{})
  return out.getvalue().encode()
 def exchange(self,argv,raw,seconds):
  self.calls.append(argv);self.assertLessEqual(seconds,15)
  self.assertTrue((Path('/work/journal')/(self.c['attempt']+'-activation-launch')/'intent.json').exists())
  return self.bootstrap(raw)
 def test_delivery_through_launch_actual_seeded_imports(self):
  with patch.object(x.d,'exchange',self.exchange):r=x.send(self.config)
  self.assertEqual(self.start_count,1);self.assertEqual(len(self.calls),1)
  self.assertEqual(r['receipt']['owner']['pid'],os.getpid())
  for k in ('storageReady','rpcReady','remoteDeathProven','writersFenced','adopted'):self.assertFalse(r[k])
  self.assertEqual(list(fixture.a.STATE.iterdir()),[]) # No mocked activation execution claim.
 def test_lost_response_no_second_local_or_remote_start(self):
  def lost(*args):self.exchange(*args);raise TimeoutError('lost response')
  with patch.object(x.d,'exchange',lost):
   with self.assertRaises(TimeoutError):x.send(self.config)
   with self.assertRaises(FileExistsError):x.send(self.config)
  self.started=False
  with self.assertRaises(FileExistsError):self.bootstrap()
  self.assertEqual(self.start_count,1)
 def test_failed_systemd_submission_remains_consumed(self):
  self.start_failure=True
  with self.assertRaises(RuntimeError):self.bootstrap()
  self.started=False
  with self.assertRaises(FileExistsError):self.bootstrap()
  self.assertEqual(self.start_count,1)
 def test_bad_envelope_refused_before_stdin(self):
  class Unread:
   def read(self,*args):raise AssertionError('Unqualified envelope read stdin')
  def change(unit,row):
   if unit.startswith('enclave-rpc-activation-launch-'):row['RuntimeMaxUSec']='11s'
  self.change=change
  with self.assertRaises(ValueError):self.bootstrap(stdin=Unread())
  self.assertEqual(self.start_count,0)
 def test_existing_owner_refused_before_submission(self):
  self.started=True
  with self.assertRaises(ValueError):self.bootstrap()
  self.assertEqual(self.start_count,0)
 def test_seeded_source_drift_before_import(self):
  Path('/opt/enclave-rpc/identity.py').write_bytes(b'raise AssertionError("must not import")')
  with self.assertRaises(ValueError):self.bootstrap()
  self.assertEqual(self.start_count,0)
 def test_changed_installed_request_before_submission(self):
  put(fixture.a.REQUEST,b'{}')
  with self.assertRaises(ValueError):self.bootstrap()
  self.assertEqual(self.start_count,0)
 def test_changed_guest_delivery_receipt_before_submission(self):
  put(Path('/var/lib/enclave-rpc-delivery')/self.c['attempt']/'receipt.json',b'{}')
  with self.assertRaises(ValueError):self.bootstrap()
  self.assertEqual(self.start_count,0)
 def test_local_delivery_receipt_foreign_attempt(self):
  path=Path(self.config['deliveryReceipt']['path']);r=json.loads(path.read_bytes());r['attempt']='00'*16;put(path,json.dumps(r,sort_keys=True).encode()+b'\n');self.config['deliveryReceipt']['sha256']=p.sha(path.read_bytes())
  with patch.object(x.d,'exchange',self.exchange):
   with self.assertRaises(ValueError):x.send(self.config)
  self.assertEqual(self.calls,[])
 def test_watchdog_and_cgroup_identity_refusals(self):
  for field,value in [('WatchdogTimestampMonotonic','0'),('ControlGroup','/foreign')]:
   with self.subTest(field=field):
    self.setUp()
    def change(unit,row):
     if unit==fixture.a.UNIT and self.started:row[field]=value
    self.change=change
    with self.assertRaises(ValueError):self.bootstrap()
    self.assertEqual(self.start_count,1)
    self.assertFalse((Path('/var/lib/enclave-rpc-activation-launch')/self.c['attempt']/'receipt.json').exists())
 def test_unit_definition_refusal(self):
  def change(unit,row):
   if unit==fixture.a.UNIT:row['Restart']='always'
  self.change=change
  with self.assertRaises(ValueError):self.bootstrap()
  self.assertEqual(self.start_count,0)
 def test_bound_input_and_wrong_boot(self):
  with self.assertRaises(ValueError):self.bootstrap(b'x'*65537)
  raw,c,_,pins=x.package(self.config,time.time_ns());args=x.remote_command(c,raw,pins);args=['bootstrap',*args[args.index('-c')+2:]];args[2]='00000000-0000-0000-0000-000000000000'
  with self.assertRaises(ValueError):self.bootstrap(argv=args)
  self.assertEqual(self.start_count,0)
 def test_expired_original_window_no_transport(self):
  with patch.object(x.time,'time_ns',return_value=self.c['deadlineUtcNs']),patch.object(x.d,'exchange',self.exchange):
   with self.assertRaises(ValueError):x.send(self.config)
  self.assertEqual(self.calls,[])
 def test_false_readiness_claim_refused(self):
  def changed(*args):r=json.loads(self.exchange(*args));r['storageReady']=True;return json.dumps(r).encode()
  with patch.object(x.d,'exchange',changed):
   with self.assertRaises(ValueError):x.send(self.config)
  self.assertEqual(self.start_count,1)
 def test_exact_remote_envelope_and_pinned_jump(self):
  put('/work/jump-known',b'jump ssh-ed25519 fixture\n')
  self.config['jump']={'endpoint':dict(self.config['target'],host='192.0.2.1',user='owner'),'alias':'jump','knownHosts':{'path':'/work/jump-known','sha256':p.sha(Path('/work/jump-known').read_bytes())}}
  with patch.object(x.d,'exchange',self.exchange):x.send(self.config)
  argv=self.calls[0];remote=shlex.split(argv[-1]);proxy=shlex.split(next(v.split('=',1)[1]for v in argv if v.startswith('-oProxyCommand=')))
  for vector in (argv,proxy):
   for value in ('-oStrictHostKeyChecking=yes','-oGlobalKnownHostsFile=/dev/null','-oForwardAgent=no'):self.assertIn(value,vector)
  for value in ('RuntimeMaxSec=10','MemoryMax=64M','MemorySwapMax=0','Restart=no','KillMode=control-group','StateDirectoryMode=0700'):self.assertIn('--property='+value,remote)
  self.assertEqual(remote[remote.index('-c')+1],x.BOOTSTRAP)
if __name__=='__main__':unittest.main(verbosity=2)

"""Exact observation bootstrap and seeded validation; SSH/systemd/sysfs mocked.

Private disposable root namespace only. Real files and pidfd/proc reads are not
live NBD attachment, guest systemd or production RPC qualification.
"""
import importlib.util,io,json,os,shlex,subprocess,sys,time,unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
 s=importlib.util.spec_from_file_location(name,ROOT/path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
fixture=load('launch_fixture','test/rpc-guest/test_launch_activation.py')
x=load('activation_observer','rpc/observe_activation.py');a=fixture.fixture.a;put=fixture.put;p=x.p
class Tests(unittest.TestCase):
 def setUp(self):
  self.l=fixture.Tests('test_delivery_through_launch_actual_seeded_imports');self.l.setUp();self.c=self.l.c
  with patch.object(fixture.x.d,'exchange',self.l.exchange):fixture.x.send(self.l.config)
  self.config=dict(self.l.config);path=Path('/work/journal')/(self.c['attempt']+'-activation-launch')/'receipt.json'
  self.config['launchReceipt']={'path':str(path),'sha256':p.sha(path.read_bytes())}
  self.launch=json.loads(path.read_bytes());_,self.state,contract_sha=a.stage(a.REQUEST.read_bytes(),self.launch['owner']['invocation'])
  proc=Path('/proc/self/stat').read_text();start=proc[proc.rfind(')')+2:].split()[19]
  roles={}
  for i,role in enumerate(a.ROLES):
   block=Path('/sys/block')/a.attachment.ROLES[role]['device'];device='43:'+str(192+i*32)
   for name,value in [('dev',device),('pid',str(os.getpid())),('size',str(p.BYTES//512))]:put(block/name,value.encode(),0o644)
   row={'attempt':self.c['attempt'],'bootId':self.c['bootId'],'contractSha256':contract_sha,'uuid':self.c['roles'][role]['uuid'],'bytes':p.BYTES,'unitInvocation':'78'*16,'device':device,'mountReady':True,'rpcReady':False,'ownerPid':os.getpid(),'ownerStart':start}
   path=Path('/run/enclave-rpc-attachment')/(self.c['attempt']+'-'+role)/'ready.json';put(path,row)
   roles[role]={'unit':'enclave-rpc-attach-'+role+'.service','invocation':'78'*16,'readySha256':p.sha(path.read_bytes()),'ownerPid':os.getpid(),'ownerStart':start}
  self.ready={'attempt':self.c['attempt'],'bootId':self.c['bootId'],'requestSha256':p.sha(a.REQUEST.read_bytes()),'contractSha256':contract_sha,'roles':roles,'atUtcNs':time.time_ns(),'rpcReady':False,'writersFenced':False}
  put(self.state/'ready.json',self.ready);self.calls=[];self.change=lambda unit,row:None
 def systemctl(self,argv,**kwargs):
  self.assertEqual(argv[:2],['/usr/bin/systemctl','show']) # Observer must never start/stop anything.
  unit=argv[2]
  if unit.startswith('enclave-rpc-activation-observe-'):
   row=self.l.f.f.unit(active=True);row.update(Id=unit,Type='exec',RuntimeMaxUSec='95s',MemoryMax=str(64<<20))
  elif unit==a.UNIT:
   row=self.l.f.f.unit(active=True);row.update(InvocationID=self.launch['owner']['invocation'],WatchdogTimestampMonotonic=str(time.monotonic_ns()//1000))
  else:
   role='l1'if unit.endswith('-l1.service')else'base';self.assertEqual(unit,'enclave-rpc-attach-'+role+'.service')
   row=self.l.f.f.unit(role,True);row['InvocationID']='78'*16
  self.change(unit,row)
  return SimpleNamespace(returncode=0,stdout=('\n'.join(k+'='+v for k,v in row.items())+'\n').encode(),stderr=b'')
 def bootstrap(self,raw=None,stdin=None):
  supplied,c,_,pins=x.package(self.config,time.time_ns());raw=supplied if raw is None else raw
  command=x.remote_command(c,supplied,pins);args=['bootstrap',*command[command.index('-c')+2:]];out=io.StringIO()
  with patch.object(subprocess,'run',self.systemctl),patch.object(sys,'argv',args),patch.object(sys,'stdin',SimpleNamespace(buffer=io.BytesIO(raw)if stdin is None else stdin)),redirect_stdout(out):
   exec(compile(x.BOOTSTRAP,'<exact-observation-bootstrap>','exec'),{})
  return out.getvalue().encode()
 def exchange(self,argv,raw,seconds):
  self.calls.append(argv);self.assertLessEqual(seconds,100)
  self.assertTrue((Path('/work/journal')/(self.c['attempt']+'-activation-observe')/'intent.json').exists())
  return self.bootstrap(raw)
 def test_full_delivery_launch_collect_exact_public_files(self):
  with patch.object(x.d,'exchange',self.exchange):r=x.observe(self.config)
  self.assertEqual(Path(r['activationRequest']['path']).read_bytes(),a.REQUEST.read_bytes())
  self.assertEqual(Path(r['activationReady']['path']).read_bytes(),(self.state/'ready.json').read_bytes())
  self.assertEqual(len(self.calls),1);self.assertEqual(self.l.start_count,1)
  for k in ('rpcReady','adopted','remoteDeathProven','writersFenced'):self.assertFalse(r[k])
 def test_waits_for_ready_without_resubmitting_start(self):
  raw=(self.state/'ready.json').read_bytes();(self.state/'ready.json').unlink();calls=[]
  def publish(seconds):calls.append(seconds);put(self.state/'ready.json',raw)
  with patch.object(time,'sleep',publish):r=json.loads(self.bootstrap())
  self.assertTrue(r['kernelAttachmentsObserved']);self.assertEqual(calls,[.1]);self.assertEqual(self.l.start_count,1)
 def test_collected_files_feed_actual_runtime_preparer(self):
  with patch.object(x.d,'exchange',self.exchange):observed=x.observe(self.config)
  preparer=load('prepare_runtime','rpc/prepare_runtime.py')
  seed_path=Path(self.config['seedReceipt']['path']);seed=json.loads(seed_path.read_bytes())
  for path,mode in preparer.runtime.required_pins().items():
   name=Path(path).name
   if path.startswith('/etc/systemd/system/'):
    source=ROOT/'rpc/guest/units'/path.removeprefix('/etc/systemd/system/');data=source.read_bytes()
   elif name=='start_runtime.py':data=(ROOT/'rpc/guest/start_runtime.py').read_bytes()
   elif Path(path).exists():data=Path(path).read_bytes()
   else:data=b'{}'
   seed['records'][path]={'sha256':p.sha(data),'mode':format(mode,'04o')}
  put(seed_path,seed);put('/work/image-receipt.json',{'schema':'rpc-offline-image/1','installedFiles':{}})
  cfg={'phase':'l1','output':'/work/runtime-request','activationRequest':observed['activationRequest'],'activationReady':observed['activationReady'],'attachmentReceipt':self.config['attachmentReceipt'],'seedReceipt':{'path':str(seed_path),'sha256':p.sha(seed_path.read_bytes())},'imageReceipt':{'path':'/work/image-receipt.json','sha256':p.sha(Path('/work/image-receipt.json').read_bytes())}}
  result=preparer.prepare(cfg)
  self.assertEqual(result['deadlineUtcNs'],self.c['deadlineUtcNs']);self.assertFalse(result['clientsStarted'])
 def test_original_owner_replacement_refused(self):
  def change(unit,row):
   if unit==a.UNIT:row['InvocationID']='99'*16
  self.change=change
  with self.assertRaises(ValueError):self.bootstrap()
 def test_kernel_identity_change_refused(self):
  put(Path('/sys/block')/a.attachment.ROLES['base']['device']/'pid',b'1',0o644)
  with self.assertRaises(ValueError):self.bootstrap()
 def test_ready_contract_and_role_binding_refused(self):
  self.ready['contractSha256']='0'*64;put(self.state/'ready.json',self.ready)
  with self.assertRaises(ValueError):self.bootstrap()
 def test_loaded_watchdog_and_limits_refused(self):
  for key,value in [('WatchdogTimestampMonotonic','0'),('MemoryMax',str(256<<20))]:
   def change(unit,row):
    if unit==a.UNIT:row[key]=value
   self.change=change
   with self.assertRaises(ValueError):self.bootstrap()
 def test_observer_envelope_before_stdin(self):
  class Unread:
   def read(self,*args):raise AssertionError('Unqualified observer read input')
  def change(unit,row):
   if unit.startswith('enclave-rpc-activation-observe-'):row['RuntimeMaxUSec']='96s'
  self.change=change
  with self.assertRaises(ValueError):self.bootstrap(stdin=Unread())
 def test_lost_response_keeps_observation_consumed(self):
  def lost(*args):self.exchange(*args);raise TimeoutError('lost')
  with patch.object(x.d,'exchange',lost):
   with self.assertRaises(TimeoutError):x.observe(self.config)
   with self.assertRaises(FileExistsError):x.observe(self.config)
  self.assertEqual(len(self.calls),1);self.assertEqual(self.l.start_count,1)
 def test_altered_remote_launch_receipt_refused(self):
  put(Path('/var/lib/enclave-rpc-activation-launch')/self.c['attempt']/'receipt.json',b'{}')
  with self.assertRaises(ValueError):self.bootstrap()
 def test_unsafe_public_filename_and_claim_refused(self):
  for mutation in (lambda r:r['files'][0].update(name='../../outside'),lambda r:r.update(rpcReady=True)):
   raw,c,_,_=x.package(self.config,time.time_ns());r=json.loads(self.bootstrap());mutation(r)
   with self.assertRaises(ValueError):x.validate_receipt(r,c,raw,c['createdUtcNs'],time.time_ns())
 def test_expired_original_window_before_transport(self):
  with patch.object(x.time,'time_ns',return_value=self.c['deadlineUtcNs']),patch.object(x.d,'exchange',self.exchange):
   with self.assertRaises(ValueError):x.observe(self.config)
  self.assertEqual(self.calls,[])
 def test_pin_drift_and_input_bound(self):
  with self.assertRaises(ValueError):self.bootstrap(b'x'*8193)
  Path('/opt/enclave-rpc/identity.py').write_bytes(b'changed')
  with self.assertRaises(ValueError):self.bootstrap()
 def test_exact_remote_bound(self):
  with patch.object(x.d,'exchange',self.exchange):x.observe(self.config)
  remote=shlex.split(self.calls[0][-1])
  for value in ('RuntimeMaxSec=95','MemoryMax=64M','MemorySwapMax=0','TimeoutStopSec=1','KillMode=control-group','Restart=no'):self.assertIn('--property='+value,remote)
  self.assertEqual(remote[remote.index('-c')+1],x.BOOTSTRAP)
if __name__=='__main__':unittest.main(verbosity=2)

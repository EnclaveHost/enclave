"""Real disposable protected files; mocked systemd/kernel orchestration only."""
import importlib.util,json,os,shutil,time,unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
 s=importlib.util.spec_from_file_location(name,ROOT/path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
r=load('runtime','rpc/guest/start_runtime.py')
b=load('activation_fixture','test/rpc-guest/test_activate_storage.py')
prepare=load('runtime_preparer','rpc/prepare_runtime.py')
put=b.put

class Tests(unittest.TestCase):
 def setUp(self):
  b.Tests.setUp(self)
  self.c,self.state,self.contract_sha=r.a.stage(r.a.REQUEST.read_bytes(),self.inv)
  self.bindings={role:{'unit':'enclave-rpc-attach-'+role+'.service','invocation':'34'*16,'readySha256':'a'*64,'ownerPid':42,'ownerStart':'20'}for role in r.a.ROLES}
  ready={'attempt':self.c['attempt'],'bootId':self.c['bootId'],'requestSha256':r.p.sha(r.a.REQUEST.read_bytes()),'contractSha256':self.contract_sha,'roles':self.bindings,'atUtcNs':time.time_ns(),'rpcReady':False,'writersFenced':False}
  put(self.state/'ready.json',ready)
  pins={}
  for path,mode in r.required_pins().items():
   target=Path(path)
   if path.startswith('/etc/systemd/system/'):
    data=(ROOT/'rpc/guest/units'/path.removeprefix('/etc/systemd/system/')).read_bytes()
   elif target.name=='start_runtime.py':data=(ROOT/'rpc/guest/start_runtime.py').read_bytes()
   elif target.exists():data=target.read_bytes()
   else:data=b'{}'
   put(path,data,mode);pins[path]=r.p.sha(data)
  self.req={'phase':'l1','activationReadySha256':r.p.sha((self.state/'ready.json').read_bytes()),'activationRequestSha256':r.p.sha(r.a.REQUEST.read_bytes()),'runtimePins':pins}
  self.started=[];self.failed=None
 def row(self,unit):
  if unit==r.a.UNIT:return b.Tests.unit(self,active=True)
  if unit.startswith('enclave-rpc-attach-'):return b.Tests.unit(self,'l1'if unit.endswith('-l1.service')else'base',True)
  active=unit in self.started
  row={'Id':unit,'LoadState':'loaded','FragmentPath':'/etc/systemd/system/'+unit,'DropInPaths':'','NeedDaemonReload':'no','MainPID':str(os.getpid())if active else'0','ControlPID':'0','Job':'','ActiveState':'active'if active else'inactive','InvocationID':'56'*16,'ControlGroup':'/fixture','MemorySwapMax':'0'}
  if unit.endswith('.slice'):return row|{'MemoryMax':str(17<<30)}
  if unit in r.MOUNTS.values():
   role=next(k for k,v in r.MOUNTS.items()if v==unit);dep='enclave-rpc-attach-'+role+'.service'
   return row|{'What':'/dev/'+r.a.attachment.ROLES[role]['device'],'Where':r.WHERE[role],'Type':'ext4','Options':'rw,nosuid,nodev,noexec','BindsTo':dep,'After':dep}
  side=unit.removeprefix('enclave-rpc-').removesuffix('.service');role='base'if side=='base'else'l1'
  user={'el':'rpcl1el','cl':'rpcl1cl','base':'rpcbase'}[side]
  return row|{'DropInPaths':'/etc/systemd/system/'+unit+'.d/identity.conf','User':user,'Group':user,'Type':'exec','Restart':'no','KillMode':'control-group','Slice':'enclave-rpc-clients.slice','MemoryMax':str((7 if side=='cl'else 5)<<30),'After':r.MOUNTS[role],'BindsTo':r.MOUNTS[role]}
 def process(self,row):
  if row['ActiveState']!='active':raise ValueError('not active')
  return {'unit':row['Id'],'invocation':row['InvocationID'],'pid':int(row['MainPID']),'start':'10','cgroup':row['ControlGroup']}
 def command(self,args):
  self.assertEqual(args[:3],['--no-block','--job-mode=fail','start'])
  unit=args[-1];phase='base' if 'base' in unit else 'l1'
  side='mount' if unit.endswith('.mount') else unit.removeprefix('enclave-rpc-').removesuffix('.service')
  self.assertTrue((self.state/('runtime-'+phase+'-intent.json')).exists())
  self.assertTrue((self.state/('runtime-'+phase+'-'+side+'-submit.json')).exists())
  self.started.append(unit)
  if self.failed=='reply':raise TimeoutError('lost acknowledgement')
  if side=='mount' and self.failed=='owner':self.inv='99'*16
  return ''
 def mounted(self,role):
  self.assertIn(r.MOUNTS[role],self.started)
  return {'id':'100'if role=='l1'else'101','device':'43:192'if role=='l1'else'43:224','where':r.WHERE[role]}
 def execute(self,phase='l1'):
  req=dict(self.req,phase=phase)
  with ExitStack()as stack:
   for obj,name,value in [(r,'show',self.row),(r,'process',self.process),(r,'mounted',self.mounted),(r.a,'command',self.command),(r.a,'current_ready',lambda role,*args:self.bindings[role])]:stack.enter_context(patch.object(obj,name,value))
   return r.execute(phase,json.dumps(req).encode())
 def test_mount_before_clients_and_base_separate(self):
  result=self.execute()
  self.assertEqual(self.started,[r.MOUNTS['l1'],'enclave-rpc-el.service','enclave-rpc-cl.service'])
  self.assertFalse(result['rpcReady']);self.assertFalse(result['writersFenced']);self.assertFalse(result['adopted'])
  base=self.execute('base');self.assertEqual(self.started[-2:],[r.MOUNTS['base'],'enclave-rpc-base.service']);self.assertFalse(base['rpcReady'])
 def test_base_without_l1_refused_before_submission(self):
  with self.assertRaises(FileNotFoundError):self.execute('base')
  self.assertEqual(self.started,[])
 def test_replaced_l1_process_blocks_base(self):
  self.execute();old=self.process
  def replaced(row):
   v=old(row)
   if row['Id']=='enclave-rpc-el.service':v['start']='11'
   return v
  self.process=replaced
  with self.assertRaises(ValueError):self.execute('base')
  self.assertNotIn(r.MOUNTS['base'],self.started)
 def test_lost_reply_consumes_once(self):
  self.failed='reply'
  with self.assertRaises(TimeoutError):self.execute()
  with self.assertRaises(ValueError):self.execute()
  self.assertEqual(self.started,[r.MOUNTS['l1']]);self.assertFalse((self.state/'runtime-l1-started.json').exists())
 def test_owner_loss_after_mount_blocks_client(self):
  self.failed='owner'
  with self.assertRaises(ValueError):self.execute()
  self.assertEqual(self.started,[r.MOUNTS['l1']])
 def test_changed_pin_refused_before_intent(self):
  Path('/etc/systemd/system/enclave-rpc-cl.service').write_bytes(b'changed')
  with self.assertRaises(ValueError):self.execute()
  self.assertFalse((self.state/'runtime-l1-intent.json').exists())
 def test_changed_ready_refused(self):
  self.req['activationReadySha256']='0'*64
  with self.assertRaises(ValueError):self.execute()
  self.assertEqual(self.started,[])
 def test_loaded_budget_override_refused(self):
  original=self.row
  def overridden(unit):
   v=original(unit)
   if unit.endswith('.slice'):v['MemoryMax']=str(32<<30)
   return v
  self.row=overridden
  with self.assertRaises(ValueError):self.execute()
  self.assertEqual(self.started,[])
 def test_lifetime_dependency_refused(self):
  original=self.row
  def missing(unit):
   v=original(unit)
   if unit=='enclave-rpc-cl.service':v['BindsTo']=''
   return v
  self.row=missing
  with self.assertRaises(ValueError):self.execute()
  self.assertEqual(self.started,[])
 def test_mount_kernel_device_and_flags(self):
  block=Path('/sys/block/nbd6');put(block/'dev',b'43:192',0o644)
  fake='100 1 43:192 / /srv/enclave-l1-pair rw,nosuid,nodev,noexec - ext4 /dev/nbd6 rw\n'
  read=Path.read_text
  for line,passes in [(fake,True),(fake.replace('43:192','43:224'),False),(fake.replace(',noexec',''),False),(fake+fake,False)]:
   def read_mount(path,*args,**kwargs):return line if str(path)=='/proc/self/mountinfo'else read(path,*args,**kwargs)
   with patch.object(Path,'read_text',read_mount):
    if passes:self.assertEqual(r.mounted('l1')['device'],'43:192')
    else:
     with self.assertRaises(ValueError):r.mounted('l1')
 def test_actual_process_incarnation(self):
  row=b.Tests.unit(self,active=True);value=r.process(row);self.assertEqual(value['pid'],os.getpid())
  row['ControlGroup']='/foreign'
  with self.assertRaises(ValueError):r.process(row)
 def test_envelope_rejected_before_input(self):
  with patch.object(r,'show',return_value={}):
   with self.assertRaises((KeyError,ValueError)):r.main('l1')
 def test_original_deadline_expires_during_observation(self):
  start=time.monotonic_ns()
  with patch.object(r.time,'monotonic_ns',side_effect=[start,start,start,start+901_000_000_000]):
   with self.assertRaises(TimeoutError):self.execute()
  self.assertFalse((self.state/'runtime-l1-intent.json').exists());self.assertEqual(self.started,[])
 def prepared_config(self,missing=False):
  seed={'instance':self.c['instance'],'seedContainsPrivateCredentials':True,'records':{}}
  for path,pin in self.req['runtimePins'].items():seed['records'][path]={'sha256':pin,'mode':format(r.required_pins()[path],'04o')}
  for path,pin in self.request['runtimePins'].items():seed['records'][path]={'sha256':pin,'mode':format(r.a.required_pins()[path],'04o')}
  if missing:del seed['records']['/opt/enclave-rpc/start_runtime.py']
  inputs={'activationRequest':r.a.REQUEST.read_bytes(),'activationReady':(self.state/'ready.json').read_bytes(),
          'attachmentReceipt':(self.bundle/'RESULT.json').read_bytes(),'imageReceipt':json.dumps({'schema':'rpc-offline-image/1','installedFiles':{}}).encode(),
          'seedReceipt':json.dumps(seed).encode()}
  cfg={'phase':'l1','output':'/work/runtime-request'}
  for key,data in inputs.items():
   path=Path('/work')/(key+'-runtime.json');put(path,data);cfg[key]={'path':str(path),'sha256':r.p.sha(data)}
  return cfg
 def test_producer_to_actual_runtime_consumer(self):
  cfg=self.prepared_config();result=prepare.prepare(cfg)
  self.req=json.loads((Path(cfg['output'])/'runtime-start-l1.json').read_text())
  self.assertEqual(self.req['runtimePins']['/opt/enclave-rpc/start_runtime.py'],r.p.sha(Path('/opt/enclave-rpc/start_runtime.py').read_bytes()))
  self.assertEqual(result['deadlineUtcNs'],self.c['deadlineUtcNs']);self.assertFalse(result['clientsStarted'])
  self.assertFalse(self.execute()['rpcReady'])
  with self.assertRaises(FileExistsError):prepare.prepare(cfg)
 def test_old_seed_without_helper_refused(self):
  cfg=self.prepared_config(missing=True)
  with self.assertRaises(ValueError):prepare.prepare(cfg)
  self.assertFalse(Path(cfg['output']).exists())
 def test_wrong_boot_receipt_refused(self):
  cfg=self.prepared_config();path=Path(cfg['activationReady']['path']);v=json.loads(path.read_text());v['bootId']='different';put(path,v);cfg['activationReady']['sha256']=r.p.sha(path.read_bytes())
  with self.assertRaises(ValueError):prepare.prepare(cfg)
  self.assertFalse(Path(cfg['output']).exists())

if __name__=='__main__':unittest.main(verbosity=2)

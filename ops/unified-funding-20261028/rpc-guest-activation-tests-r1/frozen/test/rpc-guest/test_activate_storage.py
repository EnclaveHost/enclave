"""Disposable root-namespace file tests; mock systemd only for orchestration.

No native systemd, kernel NBD, credentials or production-data qualification.
The separate dependency fixture covers actual systemd lifetime behavior.
"""
import copy,importlib.util,json,os,shutil,time,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
 s=importlib.util.spec_from_file_location(name,ROOT/path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
a=load('activation','rpc/guest/activate_storage.py');p=a.protocol
prepare=load('prepare','rpc/prepare_attachment.py')
f=load('protocol_fixture','test/rpc-server/test_storage_protocol.py')
def put(path,data,mode=0o600):
 path=Path(path);path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 path.write_bytes(data if isinstance(data,bytes) else json.dumps(data).encode());path.chmod(mode)
class Complete(Exception):pass
class Tests(unittest.TestCase):
 def setUp(self):
  if os.geteuid()!=0 or not Path('/qualification-only').is_file():raise RuntimeError('Private disposable root namespace required')
  os.umask(0o077)
  for name in ['/etc/enclave-rpc','/var/lib/enclave-rpc-activation','/run/enclave-rpc-import','/run/enclave-rpc-attachment','/work','/sys/block']:
   path=Path(name)
   if path.exists():shutil.rmtree(path)
   path.mkdir(parents=True,mode=0o700)
  a.CONFIG.chmod(0o755)
  self.inv='12'*16;os.environ['INVOCATION_ID']=self.inv
  boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
  server,ready,cred,_=f.fixture();credentials=p.decode(cred)
  for role,row in credentials['roles'].items():
   folder=a.CONFIG/'storage'/credentials['attempt']/role
   for name,data in [('ca-cert.pem',b'fixture-ca'),('client-cert.pem',b'fixture-certificate'),('client-key.pem',b'fixture-placeholder-no-key')]:put(folder/name,data)
   row['caSha256']=p.sha(b'fixture-ca');row['clientCertificateSha256']=p.sha(b'fixture-certificate')
  config={'instance':credentials['instance'],'guestBootId':boot,'output':'/run/enclave-rpc-import/'+credentials['attempt']}
  for field,data in [('serverContract',server),('serverReady',ready),('credentialReceipt',json.dumps(credentials).encode())]:
   path=Path('/work')/(field+'.json');put(path,data);config[field]={'path':str(path),'sha256':p.sha(data)}
  self.result=prepare.prepare(config);self.bundle=Path(config['output']);self.contract=p.decode((self.bundle/'attachment.json').read_bytes())
  runtime={}
  for name in ['manifest.json','chain_service.py']:
   path=Path('/opt/enclave-rpc')/name;put(path,b'fixture-runtime',0o644);runtime[str(path)]=p.sha(path.read_bytes())
  put('/var/lib/cloud/data/instance-id',credentials['instance'].encode(),0o644)
  put(a.CONFIG/'identity.json',{'schema':'owned-rpc-identity/1','instance':credentials['instance'],'runtimePins':runtime},0o644)
  pins={}
  for target,mode in a.required_pins().items():
   path=Path(target);name=path.name
   source=ROOT/('rpc/storage_protocol.py' if name=='storage_protocol.py' else 'rpc/guest/'+('units/' if name.endswith('.service') else '')+name)
   put(path,source.read_bytes(),mode);pins[target]=p.sha(source.read_bytes())
  self.request={'bundle':str(self.bundle),'resultSha256':p.sha((self.bundle/'RESULT.json').read_bytes()),'runtimePins':pins}
  put(a.REQUEST,self.request)
 def stage(self):return a.stage(a.REQUEST.read_bytes(),self.inv)
 def unit(self,role=None,active=False):
  unit=a.UNIT if role is None else 'enclave-rpc-attach-'+role+'.service'
  row={'Id':unit,'LoadState':'loaded','FragmentPath':'/etc/systemd/system/'+unit,'DropInPaths':'','NeedDaemonReload':'no','Restart':'no','KillMode':'control-group','MemoryMax':str(128<<20),'MemorySwapMax':'0','CPUQuotaPerSecUSec':'1s','BindsTo':a.UNIT,'After':a.UNIT,'ActiveState':'active' if active else 'inactive','MainPID':str(os.getpid()) if active else '0','ControlPID':'0','Job':'','InvocationID':self.inv,'ControlGroup':Path('/proc/self/cgroup').read_text().strip()[3:]}
  if role is None:row.update(MainPID=str(os.getpid()),Type='notify',NotifyAccess='main',WatchdogUSec='2s',WatchdogSignal='9',TimeoutStartUSec='3s',TimeoutStopUSec='1s',SendSIGKILL='yes',FinalKillSignal='9',WatchdogTimestampMonotonic='1')
  return row
 def test_install_exact_bytes_and_consume_once(self):
  c,state,h=self.stage();self.assertEqual(h,p.sha((self.bundle/'attachment.json').read_bytes()))
  for name in ['attachment.json','server-ready.json']:
   self.assertEqual((a.CONFIG/name).read_bytes(),(self.bundle/name).read_bytes());self.assertEqual((a.CONFIG/name).stat().st_mode&0o777,0o600)
  self.assertEqual(json.loads((state/'intent.json').read_text())['unitInvocation'],self.inv)
  with self.assertRaises(FileExistsError):self.stage()
 def test_tampered_bundle_before_consumption(self):
  put(self.bundle/'server-ready.json',b'{}')
  with self.assertRaises(ValueError):self.stage()
  self.assertEqual(list(a.STATE.iterdir()),[])
 def test_source_pin_and_installed_mode_refusal(self):
  path=Path('/opt/enclave-rpc/activate_storage.py');path.chmod(0o644)
  with self.assertRaises(ValueError):self.stage()
  path.chmod(0o755);path.write_bytes(b'changed')
  with self.assertRaises(ValueError):self.stage()
  self.assertEqual(list(a.STATE.iterdir()),[])
 def test_private_key_permissions(self):
  path=a.CONFIG/'storage'/self.contract['attempt']/'base/client-key.pem';path.chmod(0o644)
  with self.assertRaises(ValueError):self.stage()
 def test_wrong_guest_instance(self):
  put('/var/lib/cloud/data/instance-id',b'rpc-owned-other-instance',0o644)
  with self.assertRaises(ValueError):self.stage()
 def test_symlink_and_hardlink_refused(self):
  path=self.bundle/'RESULT.json';raw=path.read_bytes();path.unlink();put('/work/replacement',raw);path.symlink_to('/work/replacement')
  with self.assertRaises(ValueError):self.stage()
  path.unlink();os.link('/work/replacement',path)
  with self.assertRaises(ValueError):self.stage()
 def test_partial_install_remains_consumed(self):
  put(a.CONFIG/'server-ready.json',b'prior-partial')
  with self.assertRaises(FileExistsError):self.stage()
  self.assertTrue((a.STATE/self.contract['attempt']/'intent.json').exists())
  self.assertEqual((a.CONFIG/'server-ready.json').read_bytes(),b'prior-partial')
  with self.assertRaises(FileExistsError):self.stage()
 def test_lifetime_dependency_required(self):
  row=self.unit('l1');a.validate_unit(row,row['Id'])
  for key in ['BindsTo','After']:
   bad=dict(row);bad[key]=''
   with self.assertRaises(ValueError):a.validate_unit(bad,bad['Id'])
 def test_adoption_cannot_extend_or_change_binding(self):
  path=Path('/work/adoption');now=time.time_ns();c=self.contract;data={'attempt':c['attempt'],'bootId':c['bootId'],'activationRequestSha256':'a'*64,'activationReadySha256':'b'*64,'adoptedUtcNs':now}
  put(path,data);self.assertEqual(a.adoption(path,c,'a'*64,'b'*64,now),p.sha(path.read_bytes()))
  with self.assertRaises(ValueError):a.adoption(path,c,'a'*64,'b'*64,c['deadlineUtcNs'])
  with self.assertRaises(ValueError):a.adoption(path,c,'c'*64,'b'*64,now)
  data['adoptedUtcNs']=now+1;put(path,data)
  with self.assertRaises(ValueError):a.adoption(path,c,'a'*64,'b'*64,now)
 def test_actual_process_identity_with_synthetic_kernel_view(self):
  c,state,h=self.stage();role='l1';block=Path('/sys/block/nbd6');text=Path('/proc/self/stat').read_text();start=text[text.rfind(')')+2:].split()[19]
  for name,data in [('dev',b'43:192'),('pid',str(os.getpid()).encode()),('size',str(p.BYTES//512).encode())]:put(block/name,data,0o644)
  ready=Path('/run/enclave-rpc-attachment')/(c['attempt']+'-l1')/'ready.json'
  receipt={'attempt':c['attempt'],'bootId':c['bootId'],'contractSha256':h,'uuid':c['roles'][role]['uuid'],'bytes':p.BYTES,'device':'43:192','unitInvocation':self.inv,'mountReady':True,'rpcReady':False,'ownerPid':os.getpid(),'ownerStart':start}
  put(ready,receipt);props=self.unit(role,True);a.current_ready(role,c,h,props)
  put(block/'pid',b'1',0o644)
  with self.assertRaises(ValueError):a.current_ready(role,c,h,props)
  put(block/'pid',str(os.getpid()).encode(),0o644);receipt['ownerStart']='0';put(ready,receipt)
  with self.assertRaises(ValueError):a.current_ready(role,c,h,props)
 def orchestrate(self,failure=None):
  starts=[];ready=[];notifications=[]
  def show(unit):
   if unit==a.UNIT:return self.unit(active=True)
   role='l1' if unit.endswith('-l1.service') else 'base'
   return self.unit(role,role in starts)
  def command(args):
   role='l1' if args[-1].endswith('-l1.service') else 'base'
   self.assertTrue((a.STATE/self.contract['attempt']/(role+'-intent.json')).exists())
   self.assertTrue(any(x.startswith('READY=1') for x in notifications));starts.append(role)
   if role=='base':self.assertIn('l1',ready)
   if failure=='response':raise TimeoutError('ambiguous response')
   return ''
  def current(role,*args):
   if failure=='l1':raise ValueError('L1 not ready')
   ready.append(role);return {'unit':role,'invocation':self.inv}
  def adoption(*args):raise Complete()
  with patch.object(a,'show',show),patch.object(a,'command',command),patch.object(a,'notify',notifications.append),patch.object(a,'current_ready',current),patch.object(a,'adoption',adoption):
   with self.assertRaises(Complete if failure is None else (ValueError if failure=='l1' else TimeoutError)):a.main()
  return starts
 def test_sequence_l1_ready_before_base_and_no_rpc_claim(self):
  self.assertEqual(self.orchestrate(),['l1','base'])
  r=p.decode((a.STATE/self.contract['attempt']/'ready.json').read_bytes());self.assertFalse(r['rpcReady']);self.assertFalse(r['writersFenced'])
 def test_l1_failure_does_not_start_base(self):self.assertEqual(self.orchestrate('l1'),['l1'])
 def test_unknown_start_response_never_resubmitted(self):self.assertEqual(self.orchestrate('response'),['l1'])
if __name__=='__main__':unittest.main(verbosity=2)

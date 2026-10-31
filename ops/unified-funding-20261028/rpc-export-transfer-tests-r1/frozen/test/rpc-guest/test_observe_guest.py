"""Real protected files and exact transported bootstrap; SSH/systemd mocked.

Run only in the disposable root namespace. These checks are not live guest
authentication, VM association, hardware attestation or systemd qualification.
"""
import importlib.util,io,json,os,shlex,subprocess,sys,time,unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
 s=importlib.util.spec_from_file_location(name,ROOT/path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
fixture=load('guest_delivery_fixture','test/rpc-guest/test_deliver_activation.py')
x=load('guest_observer','rpc/observe_guest.py');p=x.p;put=fixture.put
class Tests(unittest.TestCase):
 def setUp(self):
  self.f=fixture.Tests('test_owner_package_to_actual_receiver_to_activation_stage');self.f.setUp()
  server_path=Path('/work/serverContract.json');server=json.loads(server_path.read_bytes())
  server['startupClock']={'path':'/original-owner/attempt/clock.json','sha256':'c'*64};put(server_path,server)
  self.server=server
  ready_path=Path('/work/serverReady.json');ready=json.loads(ready_path.read_bytes());ready['contractSha256']=p.sha(server_path.read_bytes());put(ready_path,ready)
  seed_path=Path('/work/seed.json');seed=json.loads(seed_path.read_bytes())
  for path,mode in x.FILES.items():
   Path(path).chmod(mode);seed['records'][path]={'sha256':p.sha(Path(path).read_bytes()),'mode':format(mode,'04o')}
  put(seed_path,seed)
  self.config={k:self.f.config[k]for k in ('target','jump','sshSha256','journalRoot')}
  self.config.update(serverContract=self.pin(server_path),seedReceipt=self.pin(seed_path))
  self.calls=[];self.change=lambda row:None
 def pin(self,path):return {'path':str(path),'sha256':p.sha(Path(path).read_bytes())}
 def systemctl(self,argv,**kwargs):
  self.assertEqual(argv[:2],['/usr/bin/systemctl','show']);self.assertEqual(argv[2],'enclave-rpc-guest-observe-'+self.server['attempt']+'.service')
  row={'Id':argv[2],'MainPID':str(os.getpid()),'InvocationID':os.environ['INVOCATION_ID'],'ControlGroup':Path('/proc/self/cgroup').read_text().strip()[3:],'Type':'exec','RuntimeMaxUSec':'10s','TimeoutStopUSec':'1s','MemoryMax':str(64<<20),'MemorySwapMax':'0','CPUQuotaPerSecUSec':'1s','KillMode':'control-group','Restart':'no','SendSIGKILL':'yes','FinalKillSignal':'9','User':'root','Group':'root','TasksMax':'8','NoNewPrivileges':'yes','ProtectSystem':'strict','ProtectHome':'yes','PrivateNetwork':'yes'}
  self.change(row);return SimpleNamespace(stdout=('\n'.join(k+'='+v for k,v in row.items())+'\n').encode())
 def bootstrap(self):
  c,_,pins,binding=x.package(self.config,time.time_ns());remote=x.remote_command(c,pins,binding)
  out=io.StringIO();args=['bootstrap',*remote[remote.index('-c')+2:]]
  with patch.object(subprocess,'run',self.systemctl),patch.object(sys,'argv',args),redirect_stdout(out):
   exec(compile(x.BOOTSTRAP,'<exact-guest-observer-bootstrap>','exec'),{})
  return out.getvalue().encode()
 def exchange(self,argv,raw,seconds):
  self.calls.append(argv);self.assertEqual(raw,b'');self.assertLessEqual(seconds,15)
  self.assertTrue((Path('/work/journal')/(self.server['attempt']+'-guest-observe')/'intent.json').is_file())
  self.assertEqual(shlex.split(argv[-1])[shlex.split(argv[-1]).index('-c')+1],x.BOOTSTRAP)
  return self.bootstrap()
 def test_real_seeded_identity_to_actual_attachment_preparer(self):
  with patch.object(x.d,'exchange',self.exchange):r=x.observe(self.config)
  self.assertEqual(r['guestBootId'],Path('/proc/sys/kernel/random/boot_id').read_text().strip())
  observed=p.decode(x.owner.read_pinned(r['receipt']));self.assertEqual(observed['instance'],self.server['instance']);self.assertEqual(len(self.calls),1)
  prepare=load('attachment_preparer','rpc/prepare_attachment.py')
  cfg={k:self.pin(Path('/work')/(k+'.json'))for k in ('serverContract','serverReady','credentialReceipt')}
  cfg.update(instance=self.server['instance'],guestBootId=r['guestBootId'],output='/work/observed-attachment')
  attachment=prepare.prepare(cfg);self.assertEqual(attachment['guestBootId'],r['guestBootId']);self.assertEqual(attachment['deadlineUtcNs'],self.server['deadlineUtcNs'])
  for key in ('rpcReady','storageAttached','attestationVerified','vmAssociationVerified','remoteDeathProven','writersFenced'):self.assertFalse(r[key])
 def test_lost_reply_consumed_without_second_transport(self):
  def lost(*args):self.exchange(*args);raise TimeoutError('lost reply')
  with patch.object(x.d,'exchange',lost):
   with self.assertRaises(TimeoutError):x.observe(self.config)
   with self.assertRaises(FileExistsError):x.observe(self.config)
  self.assertEqual(len(self.calls),1)
 def test_seed_host_key_substitution_before_transport(self):
  path=Path('/work/seed.json');seed=json.loads(path.read_bytes());seed['credentialPublic']['sshHostFingerprint']='SHA256:foreign';put(path,seed);self.config['seedReceipt']=self.pin(path)
  with patch.object(x.d,'exchange',self.exchange):
   with self.assertRaises(ValueError):x.observe(self.config)
  self.assertEqual(self.calls,[])
 def test_foreign_seed_instance_and_attempt(self):
  for field in ('instance','attempt'):
   path=Path('/work/seed.json');seed=json.loads(path.read_bytes())
   if field=='instance':seed[field]='rpc-owned-other-instance'
   else:seed['credentialPublic'][field]='f'*32
   put(path,seed);self.config['seedReceipt']=self.pin(path)
   with self.assertRaises(ValueError):x.package(self.config,time.time_ns())
   self.setUp()
 def test_actual_instance_mismatch(self):
  put('/var/lib/cloud/data/instance-id',b'rpc-owned-foreign-instance',0o644)
  with self.assertRaises(ValueError):self.bootstrap()
 def test_instance_symlink_and_size_bound(self):
  path=Path('/var/lib/cloud/data/instance-id');path.unlink();put('/work/foreign',self.server['instance'].encode(),0o644);path.symlink_to('/work/foreign')
  with self.assertRaises((ValueError,OSError)):self.bootstrap()
  path.unlink();put(path,b'x'*129,0o644)
  with self.assertRaises(ValueError):self.bootstrap()
 def test_identity_source_drift_refused_before_import(self):
  Path('/opt/enclave-rpc/identity.py').write_bytes(b'raise AssertionError("must not execute")')
  with self.assertRaises(ValueError):self.bootstrap()
 def test_runtime_pin_and_file_mode_refused(self):
  Path('/opt/enclave-rpc/chain_service.py').chmod(0o777)
  with self.assertRaises(ValueError):self.bootstrap()
 def test_identity_configuration_other_runtime_refused(self):
  path=Path('/etc/enclave-rpc/identity.json');config=json.loads(path.read_bytes());config['runtimePins']['/opt/enclave-rpc/chain_service.py']='0'*64;put(path,config,0o644)
  seed_path=Path('/work/seed.json');seed=json.loads(seed_path.read_bytes());seed['records'][str(path)]['sha256']=p.sha(path.read_bytes());put(seed_path,seed);self.config['seedReceipt']=self.pin(seed_path)
  with self.assertRaises(ValueError):self.bootstrap()
 def test_envelope_refused_before_import(self):
  self.change=lambda row:row.update(MemoryMax=str(128<<20))
  Path('/opt/enclave-rpc/identity.py').unlink()
  with self.assertRaisesRegex(ValueError,'envelope'):self.bootstrap()
 def test_original_window_expired_before_transport(self):
  with patch.object(x.time,'time_ns',return_value=self.server['deadlineUtcNs']),patch.object(x.d,'exchange',self.exchange):
   with self.assertRaises(ValueError):x.observe(self.config)
  self.assertEqual(self.calls,[])
 def test_insufficient_original_time_before_transport(self):
  path=Path('/work/serverContract.json');c=json.loads(path.read_bytes());c['deadlineUtcNs']=time.time_ns()+17_000_000_000;c['createdUtcNs']=c['deadlineUtcNs']-p.WINDOW;put(path,c);self.config['serverContract']=self.pin(path)
  with patch.object(x.d,'exchange',self.exchange):
   with self.assertRaises(TimeoutError):x.observe(self.config)
  self.assertEqual(self.calls,[])
 def test_reply_binding_boot_time_and_false_claim_refusals(self):
  c,_,pins,binding=x.package(self.config,time.time_ns());valid=json.loads(self.bootstrap())
  for field,value in [('guestBootId','invalid'),('bindingSha256','0'*64),('instance','rpc-owned-other-instance'),('atUtcNs',self.server['deadlineUtcNs']),('attestationVerified',True),('rpcReady',True)]:
   r=dict(valid);r[field]=value
   with self.assertRaises(ValueError):x.validate_receipt(r,c,pins,binding,c['createdUtcNs'],time.time_ns())
 def test_exact_unit_and_pinned_jump(self):
  put('/work/jump-known',b'minipc ssh-ed25519 fixture\n')
  self.config['jump']={'endpoint':dict(self.config['target'],host='192.0.2.1',user='owner'),'alias':'minipc','knownHosts':self.pin('/work/jump-known')}
  with patch.object(x.d,'exchange',self.exchange):x.observe(self.config)
  argv=self.calls[0];remote=shlex.split(argv[-1]);self.assertTrue(any(v.startswith('-oProxyCommand=')for v in argv))
  for prop in ('RuntimeMaxSec=10','MemoryMax=64M','MemorySwapMax=0','TimeoutStopSec=1','User=root','NoNewPrivileges=yes','ProtectSystem=strict','ProtectHome=yes','PrivateNetwork=yes'):self.assertIn('--property='+prop,remote)
  self.assertIn('-oStrictHostKeyChecking=yes',argv);self.assertIn('-oForwardAgent=no',argv)
if __name__=='__main__':unittest.main(verbosity=2)

"""Owner producer/transport/actual helper fixtures and real bootstrap subprocesses.

SSH and systemd are mocked; real bootstrap tests use a pinned stub runtime only.
These are not live guest, SSH authentication, kernel-mount or RPC qualifications.
"""
import base64,hashlib,importlib.util,json,os,shlex,subprocess,time,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
 s=importlib.util.spec_from_file_location(name,ROOT/path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
fixture=load('runtime_fixture','test/rpc-guest/test_start_runtime.py')
x=load('runtime_delivery','rpc/deliver_runtime.py');put=fixture.put;p=x.p
class Tests(unittest.TestCase):
 def setUp(self):
  self.f=fixture.Tests('test_mount_before_clients_and_base_separate');self.f.setUp();self.c=self.f.c
  cfg=self.f.prepared_config();seedpath=Path(cfg['seedReceipt']['path']);seed=json.loads(seedpath.read_bytes())
  key=b'\0\0\0\x0bssh-ed25519\0\0\0\x20'+bytes(32)
  seed['readbackVerified']=True;seed['credentialPublic']={'attempt':self.c['attempt'],'sshHostPublicKey':'ssh-ed25519 '+base64.b64encode(key).decode(),'sshHostFingerprint':'SHA256:'+base64.b64encode(hashlib.sha256(key).digest()).decode().rstrip('=')}
  put(seedpath,seed);cfg['seedReceipt']['sha256']=p.sha(seedpath.read_bytes())
  cfg['attachmentReceipt']={'path':str(self.f.bundle/'RESULT.json'),'sha256':p.sha((self.f.bundle/'RESULT.json').read_bytes())}
  fixture.prepare.prepare(cfg);result=Path(cfg['output'])/'RESULT.json'
  put('/work/ssh-identity',b'never used for authentication');Path('/work/journal').mkdir(mode=0o700)
  self.config={'runtimeReceipt':{'path':str(result),'sha256':p.sha(result.read_bytes())},'attachmentReceipt':cfg['attachmentReceipt'],'seedReceipt':cfg['seedReceipt'],'guestBootId':self.c['bootId'],'target':{'host':'192.0.2.2','port':22,'user':'rpcadmin','identityFile':'/work/ssh-identity'},'jump':None,'sshSha256':p.sha(Path('/usr/bin/ssh').read_bytes()),'journalRoot':'/work/journal'}
  self.calls=[]
 def exchange(self,argv,raw,seconds):
  self.calls.append(argv);self.assertLessEqual(seconds,25)
  self.assertTrue((Path('/work/journal')/(self.c['attempt']+'-l1')/'intent.json').exists())
  self.f.req=json.loads(raw);put('/etc/enclave-rpc/runtime-start-l1.json',raw)
  result=self.f.execute()
  return json.dumps({'schema':'owned-rpc-runtime-delivery-receipt/1','requestSha256':p.sha(raw),'unitInvocation':'78'*16,'result':result}).encode()
 def test_preparer_to_sender_to_actual_helper(self):
  with patch.object(x.d,'exchange',self.exchange):out=x.send(self.config)
  self.assertEqual(len(self.calls),1);self.assertFalse(out['rpcReady']);self.assertFalse(out['adopted']);self.assertFalse(out['remoteDeathProven'])
  self.assertEqual(self.f.started,[fixture.r.MOUNTS['l1'],'enclave-rpc-el.service','enclave-rpc-cl.service'])
 def test_lost_ack_consumes_local_phase_without_second_call(self):
  def lost(*args):self.exchange(*args);raise TimeoutError('lost ack')
  with patch.object(x.d,'exchange',lost):
   with self.assertRaises(TimeoutError):x.send(self.config)
   with self.assertRaises(FileExistsError):x.send(self.config)
  self.assertEqual(len(self.calls),1)
  self.assertFalse((Path('/work/journal')/(self.c['attempt']+'-l1')/'receipt.json').exists())
 def test_foreign_boot_receipt_is_not_success(self):
  def changed(*args):v=json.loads(self.exchange(*args));v['result']['bootId']='wrong';return json.dumps(v).encode()
  with patch.object(x.d,'exchange',changed):
   with self.assertRaises(ValueError):x.send(self.config)
 def test_runtime_request_tamper_refused_before_transport(self):
  put('/work/runtime-request/runtime-start-l1.json',{'phase':'base'})
  with patch.object(x.d,'exchange',self.exchange):
   with self.assertRaises(ValueError):x.send(self.config)
  self.assertEqual(self.calls,[])
 def test_seed_key_refusal_before_transport(self):
  path=Path(self.config['seedReceipt']['path']);seed=json.loads(path.read_bytes());seed['credentialPublic']['sshHostFingerprint']='SHA256:wrong';put(path,seed);self.config['seedReceipt']['sha256']=p.sha(path.read_bytes())
  with patch.object(x.d,'exchange',self.exchange):
   with self.assertRaises(ValueError):x.send(self.config)
  self.assertEqual(self.calls,[])
 def test_original_deadline_and_no_clock_extension(self):
  with patch.object(x.time,'time_ns',return_value=self.c['deadlineUtcNs']):
   with self.assertRaises(ValueError):x.send(self.config)
  self.assertEqual(list(Path('/work/journal').iterdir()),[])
 def test_remote_envelope_and_jump_pin(self):
  put('/work/jump-known',b'jump ssh-ed25519 fixture\n')
  self.config['jump']={'endpoint':dict(self.config['target'],host='192.0.2.1',user='owner'),'alias':'jump','knownHosts':{'path':'/work/jump-known','sha256':p.sha(Path('/work/jump-known').read_bytes())}}
  with patch.object(x.d,'exchange',self.exchange):x.send(self.config)
  argv=self.calls[0];remote=shlex.split(argv[-1]);proxy=shlex.split(next(a.split('=',1)[1]for a in argv if a.startswith('-oProxyCommand=')))
  for vector in (argv,proxy):
   self.assertIn('-oStrictHostKeyChecking=yes',vector);self.assertIn('-oGlobalKnownHostsFile=/dev/null',vector);self.assertIn('-oForwardAgent=no',vector)
  for prop in ('RuntimeMaxSec=20','MemoryMax=64M','MemorySwapMax=0','KillMode=control-group','Restart=no','TimeoutStopSec=1'):
   self.assertIn('--property='+prop,remote)
  self.assertFalse(any(any(k in arg for k in ('PrivateMount','ProtectSystem','PrivateTmp'))for arg in remote if arg.startswith('--property=')))
  self.assertEqual(remote[remote.index('-c')+1],x.BOOTSTRAP)
 def test_receipt_cannot_claim_rpc_adoption(self):
  def changed(*args):v=json.loads(self.exchange(*args));v['result']['adopted']=True;return json.dumps(v).encode()
  with patch.object(x.d,'exchange',changed):
   with self.assertRaises(ValueError):x.send(self.config)
 def bootstrap(self,raw=None,boot=None,deadline=None,pins_change=None,code=None):
  if raw is None:raw=b'{"phase":"l1"}'
  stub=code or "import json,os\nfrom pathlib import Path\ndef envelope(phase):\n assert phase=='l1'\ndef execute(phase,raw):\n p=Path('/etc/enclave-rpc/runtime-start-'+phase+'.json')\n assert p.read_bytes()==raw and p.stat().st_mode&0o777==0o600\n return {'fixtureOnly':True,'phase':phase}\n"
  put('/opt/enclave-rpc/start_runtime.py',stub.encode(),0o755)
  pins={name:p.sha((Path('/opt/enclave-rpc')/name).read_bytes())for name in x.IMPORTS}
  if pins_change:pins_change(pins)
  args=['/usr/bin/python3','-I','-c',x.BOOTSTRAP,'l1',boot or self.c['bootId'],p.sha(raw),str(deadline or self.c['deadlineUtcNs']),base64.b64encode(json.dumps(pins).encode()).decode()]
  return subprocess.run(args,input=raw,capture_output=True,timeout=3)
 def test_real_bootstrap_install_and_second_submission_refusal(self):
  r=self.bootstrap();self.assertEqual(r.returncode,0,r.stderr.decode());self.assertTrue(json.loads(r.stdout)['result']['fixtureOnly'])
  path=Path('/etc/enclave-rpc/runtime-start-l1.json');before=path.read_bytes()
  r=self.bootstrap();self.assertNotEqual(r.returncode,0);self.assertEqual(path.read_bytes(),before)
 def test_real_bootstrap_wrong_boot_does_not_install(self):
  r=self.bootstrap(boot='00000000-0000-0000-0000-000000000000');self.assertNotEqual(r.returncode,0)
  self.assertFalse(Path('/etc/enclave-rpc/runtime-start-l1.json').exists())
 def test_real_bootstrap_pin_drift_does_not_import(self):
  r=self.bootstrap(pins_change=lambda pins:pins.update({'start_runtime.py':'0'*64}));self.assertNotEqual(r.returncode,0)
  self.assertFalse(Path('/etc/enclave-rpc/runtime-start-l1.json').exists())
 def test_real_bootstrap_envelope_failure_precedes_publication(self):
  r=self.bootstrap(code="def envelope(phase):\n raise ValueError('wrong unit')\n")
  self.assertNotEqual(r.returncode,0);self.assertFalse(Path('/etc/enclave-rpc/runtime-start-l1.json').exists())
 def test_real_bootstrap_request_bound_and_deadline(self):
  for args in ({'raw':b'x'*65537},{'deadline':time.time_ns()-1}):
   r=self.bootstrap(**args);self.assertNotEqual(r.returncode,0)
   self.assertFalse(Path('/etc/enclave-rpc/runtime-start-l1.json').exists())
 def test_real_bootstrap_symlink_refused_without_overwrite(self):
  put('/work/other',b'unchanged');Path('/etc/enclave-rpc/runtime-start-l1.json').symlink_to('/work/other')
  r=self.bootstrap();self.assertNotEqual(r.returncode,0);self.assertEqual(Path('/work/other').read_bytes(),b'unchanged')
if __name__=='__main__':unittest.main(verbosity=2)

"""Private namespace file integration; SSH execution and systemd are mocked.

Actual local pipe/time/output limits are tested with inert Python children.
This is not SSH authentication or target guest/systemd qualification.
"""
import base64,copy,hashlib,importlib.util,json,os,shlex,shutil,time,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,ROOT/path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
fixture=load('activation_fixture','test/rpc-guest/test_activate_storage.py');a=fixture.a;p=a.protocol;put=fixture.put
d=load('delivery','rpc/deliver_activation.py')
class Tests(unittest.TestCase):
 def setUp(self):
  self.f=fixture.Tests('test_install_exact_bytes_and_consume_once');self.f.setUp();self.c=self.f.contract
  state=Path('/var/lib/enclave-rpc-delivery')
  if state.exists():shutil.rmtree(state)
  state.mkdir(mode=0o700)
  folder=Path('/work/bundle');shutil.copytree(self.f.bundle,folder);shutil.rmtree(self.f.bundle);a.REQUEST.unlink()
  key=b'\0\0\0\x0bssh-ed25519\0\0\0\x20'+bytes(32)
  public='ssh-ed25519 '+base64.b64encode(key).decode();fingerprint='SHA256:'+base64.b64encode(hashlib.sha256(key).digest()).decode().rstrip('=')
  seed={'instance':self.c['instance'],'readbackVerified':True,'seedContainsPrivateCredentials':True,'credentialPublic':{'attempt':self.c['attempt'],'sshHostPublicKey':public,'sshHostFingerprint':fingerprint},'records':{}}
  for path,mode in a.required_pins().items():seed['records'][path]={'sha256':p.sha(Path(path).read_bytes()),'mode':format(mode,'04o')}
  put('/work/seed.json',seed);put('/work/identity',b'dummy identity never used for authentication');Path('/work/journal').mkdir(mode=0o700)
  self.config={'bundleReceipt':{'path':str(folder/'RESULT.json'),'sha256':p.sha((folder/'RESULT.json').read_bytes())},'seedReceipt':{'path':'/work/seed.json','sha256':p.sha(Path('/work/seed.json').read_bytes())},'guestBootId':self.c['bootId'],'target':{'host':'192.0.2.2','port':22,'user':'rpcadmin','identityFile':'/work/identity'},'jump':None,'sshSha256':p.sha(Path('/usr/bin/ssh').read_bytes()),'journalRoot':'/work/journal'}
  self.calls=[]
 def wire(self):return d.package(self.config['bundleReceipt'],self.config['seedReceipt'],self.config['guestBootId'],time.time_ns())[0]
 def receive(self,raw):return a.receive(raw,self.c['attempt'],p.sha(raw),self.f.inv)
 def exchange(self,argv,raw,seconds):
  self.calls.append(argv);self.assertLessEqual(seconds,8)
  intent=Path('/work/journal')/self.c['attempt']/'intent.json';self.assertTrue(intent.exists())
  self.assertEqual(json.loads(intent.read_text())['wireSha256'],p.sha(raw))
  return json.dumps(self.receive(raw)).encode()
 def test_owner_package_to_actual_receiver_to_activation_stage(self):
  self.assertEqual(d.FILES,a.required_pins())
  with patch.object(d,'exchange',self.exchange):result=d.send(self.config)
  self.assertEqual(len(self.calls),1);self.assertFalse(result['activationStarted']);self.assertFalse(result['remoteDeathProven'])
  self.assertEqual(list(a.STATE.iterdir()),[])
  c,state,sha=a.stage(a.REQUEST.read_bytes(),self.f.inv)
  self.assertEqual(c,self.c);self.assertTrue((state/'intent.json').exists())
  self.assertFalse((state/'l1-intent.json').exists())
 def test_lost_ack_leaves_consumed_intent_without_replay(self):
  def lost(*args):self.exchange(*args);raise TimeoutError('lost acknowledgement')
  with patch.object(d,'exchange',lost):
   with self.assertRaises(TimeoutError):d.send(self.config)
   with self.assertRaises(FileExistsError):d.send(self.config)
  self.assertEqual(len(self.calls),1);self.assertTrue(a.REQUEST.exists())
  self.assertFalse((Path('/work/journal')/self.c['attempt']/'receipt.json').exists())
 def test_foreign_success_receipt_is_not_completion(self):
  def foreign(*args):r=json.loads(self.exchange(*args));r['bootId']='0'*36;return json.dumps(r).encode()
  with patch.object(d,'exchange',foreign):
   with self.assertRaises(ValueError):d.send(self.config)
  self.assertFalse((Path('/work/journal')/self.c['attempt']/'receipt.json').exists())
 def test_wire_hash_refused_before_consumption(self):
  raw=self.wire()
  with self.assertRaises(ValueError):a.receive(raw,self.c['attempt'],'0'*64,self.f.inv)
  self.assertEqual(list(Path('/var/lib/enclave-rpc-delivery').iterdir()),[])
 def test_receiver_refuses_runtime_substitution_before_consumption(self):
  raw=self.wire();Path('/opt/enclave-rpc/identity.py').write_bytes(b'changed')
  with self.assertRaises(ValueError):self.receive(raw)
  self.assertEqual(list(Path('/var/lib/enclave-rpc-delivery').iterdir()),[])
 def test_receiver_partial_request_is_held(self):
  raw=self.wire();put(a.REQUEST,b'existing-request')
  with self.assertRaises(FileExistsError):self.receive(raw)
  self.assertTrue((Path('/var/lib/enclave-rpc-delivery')/self.c['attempt']/'intent.json').exists())
  with self.assertRaises(FileExistsError):self.receive(raw)
  self.assertEqual(a.REQUEST.read_bytes(),b'existing-request')
 def test_receiver_checks_original_deadline(self):
  raw=self.wire()
  with patch.object(a.time,'time_ns',return_value=self.c['deadlineUtcNs']):
   with self.assertRaises(ValueError):self.receive(raw)
  self.assertFalse(a.REQUEST.exists())
 def test_seed_host_key_mismatch_refused_before_submit(self):
  path=Path('/work/seed.json');seed=json.loads(path.read_text());seed['credentialPublic']['sshHostFingerprint']='SHA256:wrong';put(path,seed)
  self.config['seedReceipt']['sha256']=p.sha(path.read_bytes())
  with patch.object(d,'exchange',self.exchange):
   with self.assertRaises(ValueError):d.send(self.config)
  self.assertFalse(self.calls)
 def test_exact_remote_limit_and_jump_host_pinning(self):
  put('/work/jump-known',b'minipc ssh-ed25519 fixture\n')
  self.config['jump']={'endpoint':dict(self.config['target'],host='192.0.2.1',user='owner'),'alias':'minipc','knownHosts':{'path':'/work/jump-known','sha256':p.sha(Path('/work/jump-known').read_bytes())}}
  with patch.object(d,'exchange',self.exchange):d.send(self.config)
  argv=self.calls[0];remote=shlex.split(argv[-1]);proxy=shlex.split(next(x.split('=',1)[1] for x in argv if x.startswith('-oProxyCommand=')))
  for vector in [argv,proxy]:
   self.assertIn('-oStrictHostKeyChecking=yes',vector);self.assertIn('-oGlobalKnownHostsFile=/dev/null',vector);self.assertIn('/dev/null',vector);self.assertIn('-oControlPath=none',vector)
  self.assertIn('-W',proxy);self.assertIn('192.0.2.2:22',proxy)
  for value in ['RuntimeMaxSec=5','MemoryMax=64M','MemorySwapMax=0','Restart=no','KillMode=control-group']:self.assertIn('--property='+value,remote)
  self.assertEqual(remote[-3],'receive');self.assertNotIn('start',remote)
 def test_unknown_bundle_path_is_never_written(self):
  raw=self.wire();wire=json.loads(raw);wire['files']['../../outside']=wire['files']['RESULT.json'];raw=json.dumps(wire).encode()
  with self.assertRaises(ValueError):self.receive(raw)
  self.assertEqual(list(Path('/var/lib/enclave-rpc-delivery').iterdir()),[])
 def test_actual_local_exchange_success(self):
  out=d.exchange(['/usr/bin/python3','-I','-c','import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())'],b'public-fixture',1)
  self.assertEqual(out,b'public-fixture')
 def test_actual_local_exchange_timeout_and_output_bound(self):
  begin=time.monotonic()
  with self.assertRaises(RuntimeError):d.exchange(['/usr/bin/python3','-I','-c','import time;time.sleep(10)'],b'x',.15)
  self.assertLess(time.monotonic()-begin,2)
  with self.assertRaises(ValueError):d.exchange(['/usr/bin/python3','-I','-c','import sys;sys.stdout.write("x"*100000)'],b'x',1)
if __name__=='__main__':unittest.main(verbosity=2)

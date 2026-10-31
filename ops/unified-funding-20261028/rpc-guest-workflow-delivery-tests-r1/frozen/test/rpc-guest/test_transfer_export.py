"""Original clock and exclusive import files are real; SSH/systemd are mocked.

Run in the disposable root namespace. No cross-host or live admission proof.
"""
import base64,copy,importlib.util,io,json,os,shlex,subprocess,sys,time,unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
 s=importlib.util.spec_from_file_location(name,ROOT/path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
fixture=load('observation_fixture','test/rpc-guest/test_observe_guest.py')
x=load('export_transfer','rpc/transfer_export.py');c=x.c;p=x.p
class Tests(unittest.TestCase):
 def setUp(self):
  self.f=fixture.Tests('test_real_seeded_identity_to_actual_attachment_preparer');self.f.setUp()
  self.server=copy.deepcopy(self.f.server);attempt=self.server['attempt'];instance=self.server['instance']
  parent=Path('/work/original');parent.mkdir(mode=0o700)
  begin=c.begin(parent,attempt,instance,'b'*32)
  sample=c.write_new(parent/'sample.json',c.encode({'schema':'owned-rpc-windows-clock/1','attempt':attempt,'vmAttempt':'b'*32,'windowsBoot':'c'*32,'monotonicMilliseconds':1000000}))
  clock=c.finish(begin,sample);original=c.validate(clock)
  for k in ('bootId','createdUtcNs','deadlineUtcNs'):self.server[k]=original[k]
  self.server.update(startupClock=clock,floorMiB=27648,reserveMiB=512,stateParent='/work/export-state',sourcePins={'/work/source.py':'d'*64},resourceArgv=['/usr/bin/node','/work/observe_resources.mjs','/work/resources.json'])
  for role,row in self.server['roles'].items():row.update(parent='/work/'+role,originals=[['/work/'+role+'.qcow2',[1,2,3,4,5]]],tls='/work/'+role+'-server',clientTls='/work/'+role+'-client')
  self.save_server()
  Path('/work/recipient').mkdir(mode=0o700)
  host=b'\0\0\0\x0bssh-ed25519\0\0\0\x20'+bytes(range(32))
  known=c.write_new(Path('/work/known'),b'control ssh-ed25519 '+base64.b64encode(host)+b'\n')
  self.config={'clock':clock,'serverContract':self.pin('/work/serverContract.json'),'serverReady':self.pin('/work/serverReady.json'),'target':self.f.config['target'],'knownHosts':known,'hostAlias':'control','sshSha256':self.f.config['sshSha256'],'recipientRoot':'/work/recipient','recipientUid':os.geteuid(),'recipientBootId':original['bootId']}
  self.calls=[];self.change=lambda row:None
 def pin(self,path):return {'path':str(path),'sha256':p.sha(Path(path).read_bytes())}
 def save_server(self):
  fixture.put('/work/serverContract.json',self.server)
  ready=json.loads(Path('/work/serverReady.json').read_bytes())
  for k in ('bootId','createdUtcNs','deadlineUtcNs'):ready[k]=self.server[k]
  ready.update(contractSha256=p.sha(Path('/work/serverContract.json').read_bytes()),atUtcNs=time.time_ns())
  fixture.put('/work/serverReady.json',ready)
 def systemctl(self,argv,**kwargs):
  self.assertEqual(argv[:3],['/usr/bin/systemctl','--user','show'])
  row={'Id':argv[3],'MainPID':str(os.getpid()),'InvocationID':os.environ['INVOCATION_ID'],'ControlGroup':Path('/proc/self/cgroup').read_text().strip()[3:],'Type':'exec','RuntimeMaxUSec':'10s','TimeoutStopUSec':'1s','MemoryMax':str(64<<20),'MemorySwapMax':'0','CPUQuotaPerSecUSec':'1s','KillMode':'control-group','Restart':'no','SendSIGKILL':'yes','FinalKillSignal':'9','TasksMax':'8','NoNewPrivileges':'yes'}
  self.change(row);return SimpleNamespace(stdout=('\n'.join(k+'='+v for k,v in row.items())+'\n').encode())
 def bootstrap(self,raw=None,args=None):
  original,files,wire=x.package(self.config)
  remote=x.remote_command(original,self.config,wire)
  args=args or ['bootstrap',*remote[remote.index('-c')+2:]]
  out=io.StringIO()
  with patch.object(subprocess,'run',self.systemctl),patch.object(sys,'argv',args),patch.object(sys,'stdin',SimpleNamespace(buffer=io.BytesIO(wire if raw is None else raw))),redirect_stdout(out):
   exec(compile(x.BOOTSTRAP,'<exact-export-bootstrap>','exec'),{})
  return out.getvalue().encode()
 def exchange(self,argv,raw,seconds):
  self.calls.append(argv);self.assertLessEqual(seconds,15)
  self.assertTrue((Path(self.config['clock']['path']).parent/'guest-export-transfer/intent.json').exists())
  self.assertEqual(shlex.split(argv[-1])[shlex.split(argv[-1]).index('-c')+1],x.BOOTSTRAP)
  return self.bootstrap(raw)
 def send(self):
  with patch.object(x.d,'exchange',self.exchange):return x.transfer(self.config)
 def test_actual_import_to_guest_observer_and_attachment_producers(self):
  r=self.send();self.assertEqual(len(self.calls),1)
  observe=dict(self.f.config,serverContract=r['recipientFiles']['serverContract'])
  server,seed,pins,binding=fixture.x.package(observe,time.time_ns())
  self.assertEqual(server['deadlineUtcNs'],self.server['deadlineUtcNs'])
  prepare=load('prepare_imported','rpc/prepare_attachment.py')
  result=prepare.prepare(dict(r['recipientFiles'],credentialReceipt=self.pin('/work/credentialReceipt.json'),instance=server['instance'],guestBootId=self.config['recipientBootId'],output='/work/imported-attachment'))
  self.assertEqual(result['deadlineUtcNs'],server['deadlineUtcNs'])
  for key in ('guestSubmitted','rpcReady','remoteDeathProven','writersFenced'):self.assertFalse(r[key])
  for binding in r['recipientFiles'].values():self.assertEqual(Path(binding['path']).stat().st_mode&0o777,0o600)
 def test_lost_ack_is_consumed_on_both_hosts(self):
  def lost(*args):self.exchange(*args);raise TimeoutError('lost ack')
  with patch.object(x.d,'exchange',lost):
   with self.assertRaises(TimeoutError):x.transfer(self.config)
   with self.assertRaises(FileExistsError):x.transfer(self.config)
  self.assertEqual(len(self.calls),1)
  with self.assertRaises(FileExistsError):self.bootstrap()
 def test_partial_receiver_directory_never_overwritten(self):
  root=Path(self.config['recipientRoot'])/self.server['attempt'];root.mkdir(mode=0o700);c.write_new(root/'intent.json',b'prior-partial')
  with self.assertRaises(FileExistsError):self.send()
  self.assertEqual((root/'intent.json').read_bytes(),b'prior-partial')
 def test_wrong_recipient_boot_and_uid_before_input(self):
  original,_,raw=x.package(self.config);cmd=x.remote_command(original,self.config,raw);args=['bootstrap',*cmd[cmd.index('-c')+2:]]
  for index,value in [(-1,'f'*36),(-2,str(os.geteuid()+1))]:
   changed=list(args);changed[index]=value
   with self.assertRaisesRegex(ValueError,'recipient boot or owner'):self.bootstrap(b'not JSON',changed)
 def test_actual_envelope_before_stdin(self):
  for key,value in [('MemoryMax',str(128<<20)),('MainPID','0'),('InvocationID','0'*32),('RuntimeMaxUSec','infinity'),('NoNewPrivileges','no')]:
   self.change=lambda row:row.update({key:value})
   with self.assertRaisesRegex(ValueError,'envelope'):self.bootstrap(b'not JSON')
 def test_unsafe_and_symlink_namespace(self):
  root=Path('/work/recipient');root.chmod(0o777)
  with self.assertRaisesRegex(ValueError,'namespace'):self.bootstrap()
  root.chmod(0o700);Path('/work/link').symlink_to(root);self.config['recipientRoot']='/work/link'
  with self.assertRaisesRegex(ValueError,'namespace'):self.bootstrap()
 def test_hash_bound_and_oversized_input(self):
  for raw in (b'{}',b'x'*65537):
   with self.assertRaisesRegex(ValueError,'bounded public input'):self.bootstrap(raw)
 def test_original_clock_binding_cannot_change(self):
  self.server['startupClock']['sha256']='0'*64;self.save_server()
  self.config.update(serverContract=self.pin('/work/serverContract.json'),serverReady=self.pin('/work/serverReady.json'))
  with self.assertRaises(ValueError):self.send()
  self.assertEqual(self.calls,[])
 def test_metadata_extra_fields_and_invalid_role_refused(self):
  _,files,_=x.package(self.config)
  for field,value in [('privateKey','not allowed'),('floorMiB',18432),('sourcePins',{})]:
   server=copy.deepcopy(self.server);server[field]=value;changed=dict(files,serverContract=c.encode(server))
   with self.assertRaises(ValueError):x.validate_files(changed,time.time_ns())
  for host in ('127.0.0.1','999.1.1.1','::','224.0.0.1'):
   server=copy.deepcopy(self.server);server['roles']['l1']['host']=host
   with self.assertRaises(ValueError):x.validate_files(dict(files,serverContract=c.encode(server)),time.time_ns())
 def test_ready_must_match_hash_window_and_negotiation(self):
  _,files,_=x.package(self.config)
  for field,value in [('contractSha256','0'*64),('deadlineUtcNs',1),('rpcReady',True)]:
   ready=json.loads(files['serverReady']);ready[field]=value
   with self.assertRaises(ValueError):x.validate_files(dict(files,serverReady=c.encode(ready)),time.time_ns())
  ready=json.loads(files['serverReady']);ready['roles']['base']['flush']=False
  with self.assertRaises(ValueError):x.validate_files(dict(files,serverReady=c.encode(ready)),time.time_ns())
 def test_deadline_not_reset_or_transport_started_too_late(self):
  with patch.object(c,'remaining',return_value=17):
   with self.assertRaises(TimeoutError):self.send()
  self.assertEqual(self.calls,[])
 def test_wrong_receipt_path_is_held(self):
  def wrong(*args):
   row=json.loads(self.exchange(*args));row['files']['serverReady']['path']='/work/foreign';return c.encode(row)
  with patch.object(x.d,'exchange',wrong):
   with self.assertRaises(ValueError):x.transfer(self.config)
   with self.assertRaises(FileExistsError):x.transfer(self.config)
  self.assertEqual(len(self.calls),1)
 def test_wrong_pinned_host_refused_before_transport(self):
  self.config['hostAlias']='other'
  with self.assertRaises(ValueError):self.send()
  self.assertEqual(self.calls,[])
 def test_key_never_read_and_fixed_bounded_command(self):
  original=Path.read_bytes
  def read(path):
   if str(path)==self.config['target']['identityFile']:raise AssertionError('key read')
   return original(path)
  with patch.object(Path,'read_bytes',read):self.send()
  argv=self.calls[0];remote=shlex.split(argv[-1])
  self.assertIn('-oForwardAgent=no',argv);self.assertIn('-oStrictHostKeyChecking=yes',argv)
  for prop in ('MemoryMax=64M','MemorySwapMax=0','RuntimeMaxSec=10','TimeoutStopSec=1','CPUQuota=100%','NoNewPrivileges=yes'):self.assertIn('--property='+prop,remote)
  self.assertIn('--user',remote)
if __name__=='__main__':unittest.main(verbosity=2)

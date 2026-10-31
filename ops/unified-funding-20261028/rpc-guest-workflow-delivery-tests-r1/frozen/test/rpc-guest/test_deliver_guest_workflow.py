"""Actual native-journal lineage, sender, transported bootstrap and guest runner.

Windows/SSH/PID1/guest observations mocked; protected source/profile imports,
public writes and all downstream owner producers/senders are real. No network.
"""
import base64
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'test/rpc-server'))
import test_windows_endpoint as native

def load(name,relative):
 s=importlib.util.spec_from_file_location(name,ROOT/relative);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

fixture=load('workflow_fixture','test/rpc-guest/test_run_guest_workflow.py')
x=load('workflow_delivery','rpc/deliver_guest_workflow.py');p=x.p;c=x.c

class Tests(unittest.TestCase):
 def setUp(self):
  self.n=native.Endpoint('runTest');self.n.setUp();self.addCleanup(self.n.doCleanups)
  endpoint=native.e.observe(self.n.cfg);original=c.validate(self.n.x.clock)
  self.f=fixture.Tests('runTest');self.f.setUp();self.addCleanup(self.f.doCleanups)
  old_attempt=self.f.attempt;old_instance=self.f.server['instance']
  self.f.attempt=original['attempt'];self.f.vm=original['vmAttempt'];self.f.top=self.f.journal/(self.f.attempt+'-workflow')
  for name in ('serverContract','serverReady','credentialReceipt','seedReceipt'):
   path=Path(self.f.config[name]['path']);raw=path.read_bytes().replace(old_attempt.encode(),self.f.attempt.encode()).replace(old_instance.encode(),original['instance'].encode())
   self.f.config[name]=self.f.put(path,raw)
  server=p.decode(Path(self.f.config['serverContract']['path']).read_bytes())
  for k in ('instance','bootId','createdUtcNs','deadlineUtcNs'):server[k]=original[k]
  server.update(startupClock=self.n.x.clock,floorMiB=27648,reserveMiB=512,stateParent='/fixture/export',sourcePins={'/fixture/source.py':'d'*64},resourceArgv=['/usr/bin/node','/fixture/observe_resources.mjs','/fixture/resources.json'])
  for role,row in server['roles'].items():row.update(parent='/fixture/'+role,originals=[['/fixture/'+role+'.qcow2',[1,2,3,4,5]]],tls='/fixture/'+role+'-server',clientTls='/fixture/'+role+'-client')
  self.f.server=server;self.f.config['serverContract']=self.f.put(Path(self.f.config['serverContract']['path']),server)
  ready=p.decode(Path(self.f.config['serverReady']['path']).read_bytes())
  for k in ('bootId','createdUtcNs','deadlineUtcNs'):ready[k]=server[k]
  ready.update(contractSha256=self.f.config['serverContract']['sha256'],atUtcNs=time.time_ns())
  self.f.config['serverReady']=self.f.put(Path(self.f.config['serverReady']['path']),ready)
  self.f.config['endpointReceipt']=self.f.put(Path(self.f.config['endpointReceipt']['path']),c.read_pinned(endpoint))
  self.f.config['vmAttempt']=original['vmAttempt'];self.f.config['target']['host']='192.168.8.42'
  self.recipient=self.f.root/'recipient';self.recipient.mkdir(mode=0o700);imp=self.recipient/original['attempt'];imp.mkdir(mode=0o700)
  files={}
  for key,name in [('serverContract','server-contract.json'),('serverReady','server-ready.json')]:files[key]=self.f.put(imp/name,c.read_pinned(self.f.config[key]))
  self.source=self.f.root/'source';self.source.mkdir(mode=0o700);(self.source/'guest').mkdir(mode=0o700)
  source_pins={}
  for name in x.SOURCE_NAMES:source_pins[name]=self.f.put(self.source/name,(ROOT/'rpc'/name).read_bytes())['sha256']
  profile={k:self.f.config[k]for k in x.PROFILE_FIELDS if k!='guestIdentityFile'};profile['guestIdentityFile']=self.f.config['target']['identityFile']
  profile_pin=self.f.put(self.f.root/'profile.json',profile)
  key=b'\0\0\0\x0bssh-ed25519\0\0\0\x20'+bytes(range(32))
  self.config={'clock':self.n.x.clock,'serverContract':self.f.config['serverContract'],'serverReady':self.f.config['serverReady'],
               'endpointReceipt':endpoint,'target':dict(self.f.config['target'],host='192.0.2.10',user='owner'),
               'knownHosts':self.f.put(self.f.root/'control-known',b'control ssh-ed25519 '+base64.b64encode(key)+b'\n'),
               'hostAlias':'control','sshSha256':self.f.config['sshSha256'],'recipientRoot':str(self.recipient),
               'recipientUid':os.geteuid(),'recipientBootId':original['bootId'],'sourceRoot':str(self.source),'sourcePins':source_pins,'profile':profile_pin}
  _,_,wire=x.t.package(self.config)
  imported={'schema':'owned-rpc-export-import/1',**{k:original[k]for k in ('attempt','instance','createdUtcNs','deadlineUtcNs')},
            'wireSha256':p.sha(wire),'recipientBootId':original['bootId'],'recipientUid':os.geteuid(),'imported':True,
            'guestSubmitted':False,'rpcReady':False,'writersFenced':False,'unitInvocation':'90'*16,'atUtcNs':time.time_ns(),'files':files}
  self.config['exportReceipt']=self.f.put(self.f.root/'export-import.json',imported)
  self.calls=[];self.change=lambda row:None
  # Install only mocked SSH in the actual source-verified remote entry module.
  original_spec=importlib.util.spec_from_file_location
  def spec(name,*args,**kwargs):
   value=original_spec(name,*args,**kwargs)
   if name=='workflow_entry':
    execute=value.loader.exec_module
    def wrapped(module):
     execute(module)
     for d in (module.guest.d,module.delivery,module.launch.d,module.activation.d,module.runtime.d):
      self.f.stack.enter_context(patch.object(d,'exchange',self.f.exchange))
    value.loader.exec_module=wrapped
   return value
  self.f.stack.enter_context(patch.object(importlib.util,'spec_from_file_location',spec))
  self.f.stack.enter_context(patch.object(x.d,'exchange',self.exchange))

 def bootstrap(self,raw=None,args=None):
  original,wire=x.package(self.config);remote=x.remote_command(original,self.config,wire)
  args=args or ['bootstrap',*remote[remote.index('-c')+2:]]
  out=io.StringIO()
  with patch.object(sys,'argv',args),patch.object(sys,'stdin',SimpleNamespace(buffer=io.BytesIO(wire if raw is None else raw))),redirect_stdout(out):
   exec(compile(x.BOOTSTRAP,'<exact-workflow-bootstrap>','exec'),{})
  return out.getvalue().encode()

 def exchange(self,argv,raw,seconds):
  self.calls.append(argv);self.assertLessEqual(seconds,250)
  self.assertEqual(shlex.split(argv[-1])[shlex.split(argv[-1]).index('-c')+1],x.BOOTSTRAP)
  self.assertTrue((self.n.x.journal/'guest-workflow-submit/intent.json').exists())
  reply=json.loads(self.bootstrap(raw));self.change(reply);return c.encode(reply)

 def test_original_native_lineage_to_exact_bootstrap_and_complete_runner(self):
  result=p.decode(c.read_pinned(x.send(self.config)))
  self.assertEqual(len(self.calls),1);self.assertEqual(len(self.f.calls),6)
  self.assertEqual(result['workflow']['deadlineUtcNs'],self.f.server['deadlineUtcNs'])
  self.assertTrue(result['workflow']['clientProcessesObserved']);self.assertFalse(result['rpcReady']);self.assertFalse(result['remoteDeathProven'])
  self.assertFalse(result['workflow']['providerSettlementProven'])
  self.assertTrue((self.recipient/(self.f.attempt+'-workflow-submit')/'intent.json').exists())

 def test_lost_result_keeps_both_hosts_consumed(self):
  def lost(*args):self.exchange(*args);raise TimeoutError('synthetic lost reply')
  with patch.object(x.d,'exchange',lost):
   with self.assertRaises(TimeoutError):x.send(self.config)
   with self.assertRaises(FileExistsError):x.send(self.config)
  self.assertEqual(len(self.calls),1);self.assertEqual(len(self.f.calls),6)
  with self.assertRaises(FileExistsError):self.bootstrap()

 def test_imported_files_tamper_blocks_all_guest_calls(self):
  (self.recipient/self.f.attempt/'server-ready.json').write_bytes(b'changed')
  with self.assertRaises(ValueError):x.send(self.config)
  self.assertEqual(self.f.calls,[])

 def test_profile_pin_tamper_blocks_import_and_guest(self):
  Path(self.config['profile']['path']).write_bytes(b'changed')
  with self.assertRaises(ValueError):x.send(self.config)
  self.assertEqual(self.f.calls,[])

 def test_source_pin_tamper_refused_before_import(self):
  (self.source/'run_guest_workflow.py').write_bytes(b'raise AssertionError("never import")')
  with self.assertRaises(ValueError):x.send(self.config)
  self.assertEqual(self.f.calls,[])

 def test_unpinned_guest_protocol_shadow_refused(self):
  self.f.put(self.source/'guest/storage_protocol.py',b'raise AssertionError("never import")')
  with self.assertRaisesRegex(ValueError,'shadow'):x.send(self.config)
  self.assertEqual(self.f.calls,[])

 def test_envelope_refusal_before_stdin(self):
  self.f.bad_envelope=lambda row:row.update(MemoryMax=str(512<<20))
  with self.assertRaisesRegex(ValueError,'envelope'):self.bootstrap(b'not JSON')
  self.assertEqual(self.f.calls,[])

 def test_remote_boot_uid_refused_before_input(self):
  original,raw=x.package(self.config);command=x.remote_command(original,self.config,raw);args=['bootstrap',*command[command.index('-c')+2:]]
  args[9]='11111111-1111-1111-1111-111111111111'
  with self.assertRaisesRegex(ValueError,'UID/boot'):self.bootstrap(b'not JSON',args)
  self.assertEqual(self.f.calls,[])

 def test_wrong_wire_and_bound_refused(self):
  for raw in (b'{}',b'x'*16385):
   with self.assertRaisesRegex(ValueError,'public workflow input'):self.bootstrap(raw)
  self.assertEqual(self.f.calls,[])

 def test_recipient_partial_intent_not_overwritten(self):
  folder=self.recipient/(self.f.attempt+'-workflow-submit');folder.mkdir(mode=0o700);self.f.put(folder/'intent.json',b'prior')
  with self.assertRaises(FileExistsError):x.send(self.config)
  self.assertEqual((folder/'intent.json').read_bytes(),b'prior');self.assertEqual(self.f.calls,[])

 def test_endpoint_lineage_tamper_before_transport(self):
  path=Path(self.n.x.plan['path']);path.write_bytes(path.read_bytes()+b'x')
  with self.assertRaises(ValueError):x.send(self.config)
  self.assertEqual(self.calls,[])

 def test_another_import_recipient_cannot_launch(self):
  path=Path(self.config['exportReceipt']['path']);row=p.decode(path.read_bytes());row['recipientUid']+=1
  self.config['exportReceipt']=self.f.put(path,row)
  with self.assertRaises(ValueError):x.send(self.config)
  self.assertEqual(self.calls,[])

 def test_reply_cannot_promote_adoption_or_rpc_ready(self):
  self.change=lambda row:row['workflow'].update(adopted=True)
  with self.assertRaises(ValueError):x.send(self.config)
  self.assertFalse((self.n.x.journal/'guest-workflow-submit/RESULT.json').exists())

 def test_original_window_requires_complete_independent_cutoff(self):
  with patch.object(x.c,'remaining',return_value=254):
   with self.assertRaises(TimeoutError):x.send(self.config)
  self.assertEqual(self.calls,[])
  self.assertFalse((self.n.x.journal/'guest-workflow-submit').exists())

 def test_exact_fixed_unit_and_no_key_bytes_in_wire(self):
  original,raw=x.package(self.config);cmd=x.remote_command(original,self.config,raw)
  for prop in ('MemoryMax=256M','RuntimeMaxSec=240','TimeoutStopSec=1','MemorySwapMax=0','NoNewPrivileges=yes','TasksMax=16','Restart=no'):
   self.assertIn('--property='+prop,cmd)
  self.assertNotIn(Path(self.f.config['target']['identityFile']).read_bytes(),raw)
  self.assertNotIn('guestIdentityFile',p.decode(raw));self.assertEqual(len(p.decode(raw)['recipientFiles']),2)


if __name__=='__main__':unittest.main(verbosity=2)

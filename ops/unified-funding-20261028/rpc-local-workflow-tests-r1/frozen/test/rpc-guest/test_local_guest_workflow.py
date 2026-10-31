"""Actual local import and workflow bootstraps; PID1/guest/native replies mocked."""
from contextlib import redirect_stdout
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import test_deliver_guest_workflow as fixture

x,c,p=fixture.x,fixture.c,fixture.p

class Local(unittest.TestCase):
 def setUp(self):
  self.f=fixture.Tests('runTest');self.f.setUp();self.addCleanup(self.f.doCleanups)
  self.recipient=self.f.f.root/'local-recipient';self.recipient.mkdir(mode=0o700)
  self.config={k:v for k,v in self.f.config.items() if k not in ('target','knownHosts','hostAlias','sshSha256','recipientUid','recipientBootId','exportReceipt')}
  self.config['recipientRoot']=str(self.recipient)
  self.import_config={k:self.config[k]for k in ('clock','serverContract','serverReady','recipientRoot')}
  self.calls=[]
  self.f.f.stack.enter_context(patch.object(x.t.d,'exchange',self.exchange))
  self.f.f.stack.enter_context(patch.object(x.d,'exchange',self.exchange))
  self.lose=None

 def import_systemctl(self,argv,**kwargs):
  self.assertEqual(argv[:3],['/usr/bin/systemctl','--user','show'])
  row={'Id':argv[3],'MainPID':str(os.getpid()),'InvocationID':os.environ['INVOCATION_ID'],
       'ControlGroup':Path('/proc/self/cgroup').read_text().strip()[3:],'Type':'exec',
       'RuntimeMaxUSec':'10s','TimeoutStopUSec':'1s','MemoryMax':str(64<<20),'MemorySwapMax':'0',
       'CPUQuotaPerSecUSec':'1s','KillMode':'control-group','Restart':'no','SendSIGKILL':'yes',
       'FinalKillSignal':'9','TasksMax':'8','NoNewPrivileges':'yes'}
  return SimpleNamespace(stdout=('\n'.join(k+'='+v for k,v in row.items())+'\n').encode())

 def exchange(self,argv,raw,seconds):
  self.assertEqual(argv[0],'/usr/bin/systemd-run');self.assertIn('--user',argv)
  self.assertNotIn('/usr/bin/ssh',argv);self.assertNotIn('sudo',argv)
  code=argv[argv.index('-c')+1];args=['bootstrap',*argv[argv.index('-c')+2:]]
  self.calls.append(argv)
  kind='import' if code==x.t.BOOTSTRAP else 'workflow'
  self.assertIn(code,(x.t.BOOTSTRAP,x.BOOTSTRAP))
  self.assertLessEqual(seconds,15 if kind=='import' else 250)
  out=io.StringIO()
  with patch.object(sys,'argv',args),patch.object(sys,'stdin',SimpleNamespace(buffer=io.BytesIO(raw))),redirect_stdout(out):
   if kind=='import':
    with patch.object(subprocess,'run',self.import_systemctl):exec(compile(code,'<local-import>','exec'),{})
   else:exec(compile(code,'<local-workflow>','exec'),{})
  if self.lose==kind:raise TimeoutError('lost local '+kind+' acknowledgment')
  return out.getvalue().encode()

 def imported(self):
  result=x.t.transfer_local(self.import_config)
  self.config['exportReceipt']=result['receipt']
  return result

 def test_actual_two_local_units_to_complete_guest_workflow(self):
  imported=self.imported();result=p.decode(c.read_pinned(x.send_local(self.config)))
  self.assertEqual(len(self.calls),2);self.assertEqual(len(self.f.f.calls),6)
  self.assertEqual(result['recipientUid'],os.geteuid());self.assertEqual(result['recipientBootId'],c.validate(self.config['clock'])['bootId'])
  self.assertTrue(result['workflow']['clientProcessesObserved']);self.assertFalse(result['rpcReady'])
  self.assertFalse(result['workflow']['providerSettlementProven'])
  for key in ('serverContract','serverReady'):
   self.assertEqual(c.read_pinned(imported['recipientFiles'][key]),c.read_pinned(self.config[key]))
  for argv in self.calls:
   self.assertIn('--property=NoNewPrivileges=yes',argv);self.assertIn('--property=MemorySwapMax=0',argv)

 def test_import_ack_loss_consumed_and_no_workflow(self):
  self.lose='import'
  with self.assertRaises(TimeoutError):self.imported()
  with self.assertRaises(FileExistsError):self.imported()
  self.assertEqual(len(self.calls),1);self.assertEqual(self.f.f.calls,[])

 def test_workflow_ack_loss_consumed_with_no_second_guest_start(self):
  self.imported();self.lose='workflow'
  with self.assertRaises(TimeoutError):x.send_local(self.config)
  with self.assertRaises(FileExistsError):x.send_local(self.config)
  self.assertEqual(len(self.calls),2);self.assertEqual(len(self.f.f.calls),6)

 def test_remote_mode_cannot_replay_consumed_local_workflow(self):
  self.imported();x.send_local(self.config)
  remote=dict(self.f.config,**self.config)
  with self.assertRaises(FileExistsError):x.send(remote)
  self.assertEqual(len(self.calls),2)

 def test_caller_cannot_supply_local_uid_or_boot(self):
  for key,value in [('recipientUid',os.geteuid()),('recipientBootId',c.validate(self.config['clock'])['bootId'])]:
   with self.assertRaisesRegex(ValueError,'derived'):x.t.transfer_local(dict(self.import_config,**{key:value}))
  self.assertEqual(self.calls,[])

 def test_local_mode_rejects_ssh_recipient_fields(self):
  with self.assertRaises(ValueError):x.t.transfer_local(dict(self.import_config,target=self.f.config['target']))
  self.assertEqual(self.calls,[])

 def test_changed_profile_stops_before_any_guest_call(self):
  self.imported();Path(self.config['profile']['path']).write_bytes(b'changed')
  with self.assertRaises(ValueError):x.send_local(self.config)
  self.assertEqual(self.f.f.calls,[])

 def test_changed_import_cannot_be_promoted_to_workflow(self):
  imported=self.imported();Path(imported['recipientFiles']['serverReady']['path']).write_bytes(b'{}')
  with self.assertRaises(ValueError):x.send_local(self.config)
  self.assertEqual(self.f.f.calls,[])

 def test_short_original_window_refuses_local_workflow(self):
  self.imported()
  with patch.object(c,'remaining',return_value=254):
   with self.assertRaises(TimeoutError):x.send_local(self.config)
  self.assertEqual(len(self.calls),1)

if __name__=='__main__':unittest.main(verbosity=2)

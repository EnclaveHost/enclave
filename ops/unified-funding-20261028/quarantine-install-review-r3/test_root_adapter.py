import json,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
import quarantine_install_r2 as q

class AdapterTests(unittest.TestCase):
 def test_gate_uses_actual_inspect_field(self):
  with tempfile.TemporaryDirectory() as d:
   helper=Path(d)/'gate.py';helper.write_bytes(b'owned-test-helper')
   host=q.SystemdHost(q.Layout(gate_helper=str(helper)),q.Pins({}, {}, '', q.sha(helper.read_bytes())))
   replies=iter([{'routesSha256':'a'*64,'etag':'tag'}, {'phase':'gate-verified','ownedGateExact':True}])
   host._run=lambda argv,timeout: json.dumps(next(replies))
   self.assertEqual(host.gate_status('owned-operation')['hash'],'a'*64)
 def test_unknown_start_does_not_own_unrelated_new_invocation(self):
  old={'pid':100,'startTicks':1,'invocationId':'a'*32,'controlGroup':'/test.service'}
  current={'pid':200,'startTicks':2,'invocationId':'b'*32}
  stopped=[]
  host=SimpleNamespace(show=lambda unit:{'MainPID':200,'InvocationID':'b'*32,'ControlGroup':'/test.service','ActiveState':'active'},
      start_ticks=lambda pid:2,environ=lambda pid:b'INVOCATION_ID='+b'b'*32+b'\0',proc_cgroup=lambda pid:'/test.service',
      stop=lambda unit:stopped.append(unit),cgroup_pids=lambda cg:[200])
  inst=q.Installer(None,host);inst._seen=None
  rec=SimpleNamespace(doc={'phase':'start-unknown'})
  rec.save=lambda phase,**kw: rec.doc.update(phase=phase)
  with self.assertRaises(q.Refusal):inst._fail_after_start('owned-operation',{'oldIdentity':old},rec,'c'*32,q.Refusal('start-timeout'))
  self.assertEqual(stopped,[], 'an unrelated new invocation is not owned solely because the old PID disappeared')
if __name__=='__main__':unittest.main()

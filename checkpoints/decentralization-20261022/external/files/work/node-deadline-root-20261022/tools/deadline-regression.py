import importlib.util,pathlib,unittest,shutil
p=pathlib.Path(__file__).with_name('cutover-mock-test.py'); spec=importlib.util.spec_from_file_location('fixture',p); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
class Deadline(unittest.TestCase):
 def setUp(self): self.r=m.world()
 def tearDown(self): shutil.rmtree(self.r)
 def go(self,scenario='ok',**kw):
  lease={**m.LEASE,'revertSec':600}; return m.run(self.r,m.params(self.r,'deadline',lease=lease,**kw),scenario=scenario)
 def test_slow_pins_cannot_consume_recovery_reserve_then_stop_node(self):
  lines,c=self.go('slow-initial-pins'); self.assertTrue(m.final(lines).startswith('REFUSED'),(m.final(lines),c.stderr)); self.assertTrue(m.node_running(self.r)); self.assertEqual(m.starts(self.r),0)
 def test_fresh_lease_read_immediately_before_mutation(self):
  lines,c=self.go('lease-shrinks-after-pins'); self.assertTrue(m.final(lines).startswith('REFUSED'),(m.final(lines),c.stderr)); self.assertTrue(m.node_running(self.r)); self.assertFalse(m.flag(self.r))
 def test_exception_after_stop_cannot_claim_nothing_changed(self):
  lines,c=self.go('throw-after-task-stop'); self.assertNotIn('nothing was changed',m.final(lines)); self.assertTrue(m.final(lines).startswith('ROLLED_BACK_AFTER_CRASH'),(m.final(lines),c.stderr)); self.assertTrue(m.node_running(self.r)); self.assertFalse(m.flag(self.r)); self.assertFalse(m.block(self.r))
 def test_global_forward_deadline_reserves_recovery_even_with_long_leases(self):
  m.leases(self.r,4000); lines,c=self.go('slow-no-channel',boundSec=850)
  self.assertTrue(m.final(lines).startswith('ROLLED_BACK_R2'),(m.final(lines),c.stderr)); sn=m.step(lines,'start-node'); self.assertLessEqual(sn['sec'],252); self.assertTrue(m.node_running(self.r)); self.assertFalse(m.flag(self.r))
 def test_known_insufficient_300_second_reserve_refused(self):
  lines,c=m.run(self.r,m.params(self.r,'underbudget',lease={**m.LEASE,'revertSec':300})); self.assertTrue(m.final(lines).startswith('REFUSED'),(m.final(lines),c.stderr)); self.assertTrue(m.node_running(self.r)); self.assertIn('revert budget',m.final(lines))
if __name__=='__main__':unittest.main()

import importlib.util,pathlib,shutil,unittest
p=pathlib.Path(__file__).with_name('cutover-mock-test.py');spec=importlib.util.spec_from_file_location('fixture',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Floor(unittest.TestCase):
 def setUp(self):self.r=m.world()
 def tearDown(self):shutil.rmtree(self.r,ignore_errors=True)
 def test_underestimated_recovery_refuses_before_any_stop(self):
  budget={**m.LEASE,'revertSec':554};lines,c=m.run(self.r,m.params(self.r,'short-recovery',lease=budget))
  self.assertIn('555-second',m.final(lines));self.assertTrue(m.final(lines).startswith('REFUSED:'))
  self.assertTrue(m.node_running(self.r));self.assertEqual(m.starts(self.r),0);self.assertFalse(m.flag(self.r));self.assertFalse(m.block(self.r))
 def test_exact_full_budget_is_usable(self):
  budget={**m.LEASE,'revertSec':555};m.leases(self.r,915)
  lines,c=m.run(self.r,m.params(self.r,'full-recovery',lease=budget))
  self.assertTrue(m.final(lines).startswith('DONE:'),(m.final(lines),c.stderr[-500:]))
if __name__=='__main__':unittest.main()

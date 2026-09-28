import importlib.util, unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('pin',Path(__file__).with_name('pin-shield-cpus.py'));pin=importlib.util.module_from_spec(spec);spec.loader.exec_module(pin)

def rows(cores=16,allowed=None):
 out=[]
 for cpu in range(cores*2):
  if allowed is not None and cpu not in allowed:continue
  core=cpu%cores; llc=core//8
  out.append((cpu,(core,core+cores),tuple(i for i in range(cores*2) if i%cores//8==llc)))
 return out

class Placement(unittest.TestCase):
 def check(self,r,n):
  m=pin.plan(r,n);self.assertEqual(len(m),n);self.assertEqual(len(set(m)),n)
  by={x[0]:x for x in r};self.assertTrue(set(m)<=set(by))
  self.assertEqual(len({by[c][2] for c in m[:7]}),1)
  critical={by[c][1] for c in m[:7]};self.assertEqual(len(critical),7)
  self.assertTrue(all(by[c][1] not in critical for c in m[7:]));return m
 def test_16(self):self.check(rows(),16)
 def test_25_uses_only_refill_smt(self):self.check(rows(),25)
 def test_restricted_cpuset_selects_other_cache(self):self.check(rows(24,set(range(8,24))|set(range(32,48))),16)
 def test_secondary_siblings_allowed(self):self.check(rows(16,set(range(16,32))),16)
 def test_insufficient_allowed_cores(self):
  with self.assertRaises(ValueError):pin.plan(rows(16,set(range(6))),16)
 def test_cannot_borrow_critical_smt(self):
  with self.assertRaises(ValueError):pin.plan(rows(8),16)
 def test_invalid_size(self):
  with self.assertRaises(ValueError):pin.plan(rows(),7)

if __name__=='__main__':unittest.main()

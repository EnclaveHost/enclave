import unittest,tempfile
from pathlib import Path
import resource_guard as R
class ResourceGuardTests(unittest.TestCase):
 def test_memory_units(self):
  for raw,want in [('3072',3*R.GIB),('6144M',6*R.GIB),('48G',48*R.GIB)]:self.assertEqual(R.memory_bytes(raw),want)
  for raw in ['48G,maxmem=64G','-1','48T','']:
   with self.assertRaises(ValueError):R.memory_bytes(raw)
 def test_inventory_and_owned_exclusion(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'12';p.mkdir()
   (p/'cmdline').write_bytes(b'\0'.join([b'qemu-system-x86_64',b'-m',b'3072',b'']))
   (p/'stat').write_text('12 (qemu worker) '+' '.join(['S']+['0']*18+['123']))
   (p/'cgroup').write_text('0::/production')
   got=R.snapshot(d);self.assertEqual(got,[dict(pid=12,start='123',ram_bytes=3*R.GIB,cgroup='0::/production')])
   self.assertEqual(R.snapshot(d,12),[])
   self.assertEqual(R.check(got,got,3*R.GIB),3*R.GIB)
   for now,reserve in [([],3*R.GIB),(got,2*R.GIB),([dict(got[0],start='124')],3*R.GIB)]:
    with self.assertRaises(ValueError):R.check(got,now,reserve)

class RuntimeGuardTests(unittest.TestCase):
 def test_new_guest_aborts_and_cleans_owned_canary(self):
  import run_snp_ab as R, test_harness as T
  with tempfile.TemporaryDirectory() as d:
   out=str(Path(d)/'run')
   h=T.FakeHost(out,exit_after=99)
   h.guests=lambda exclude_pid=None: [] if h.tick==0 else [dict(pid=111,start='4',ram_bytes=3*R.B.GiB,cgroup='other')]
   p,_=T.make_plan(h,out);r=R.run_arm(h,p,p['arms'][0])
   self.assertEqual(r['outcome'],'identity_changed')
   self.assertEqual(r['host']['cleanup'],'clean')
   self.assertFalse(r['success'])
   self.assertFalse(r['digest_verified'])
 def test_reserve_above_floor_is_maintained(self):
  import run_snp_ab as R, test_harness as T
  with tempfile.TemporaryDirectory() as d:
   out=str(Path(d)/'run');h=T.FakeHost(out,avail=(100*R.B.GiB,19*R.B.GiB),exit_after=99)
   p,_=T.make_plan(h,out);r=R.run_arm(h,p,p['arms'][0])
   self.assertEqual(r['outcome'],'killed_low_host_memory')
   self.assertEqual(r['host']['cleanup'],'clean')
 def test_early_failure_receipt_includes_cleanup(self):
  import run_snp_ab as R, test_harness as T
  with tempfile.TemporaryDirectory() as d:
   out=str(Path(d)/'run');h=T.FakeHost(out,limits={'memory.max':'max','memory.swap.max':'0','cpu.max':'200000 100000'})
   p,_=T.make_plan(h,out);r=R.run_arm(h,p,p['arms'][0])
   self.assertEqual(r['outcome'],'limits_not_enforced')
   self.assertEqual(r['host']['cleanup'],'clean')

if __name__=='__main__':unittest.main()

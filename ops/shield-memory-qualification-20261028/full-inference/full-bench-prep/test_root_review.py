import copy, unittest
import fullbench as F
from test_fullbench import SNAP, plan_fixture, qemu_of
class RootReview(unittest.TestCase):
 def test_machine_cannot_detach_snp_or_replace_memory(self):
  p,arm=plan_fixture();q=qemu_of(p,arm)
  self.assertEqual(F.qemu_violations(q,p,arm),[])
  for bad in ('q35,accel=kvm','q35,accel=kvm,confidential-guest-support=sev0,memory-backend=other'):
   altered=q.copy();altered[altered.index('-machine')+1]=bad
   self.assertTrue(F.qemu_violations(altered,p,arm))
 def test_snapshot_inconsistent_counts_fail_closed(self):
  s=copy.deepcopy(SNAP);s['held']=[]
  with self.assertRaisesRegex(ValueError,'inconsistent'):F.check_snapshot(s)
 def test_snapshot_inconsistent_ram_fails_closed(self):
  s=copy.deepcopy(SNAP);s['pool']['allocatedMemMiB']+=1
  with self.assertRaisesRegex(ValueError,'inconsistent'):F.check_snapshot(s)
 def test_snapshot_allocation_and_floor_changes_yield(self):
  for k in ('allocatedMemMiB','guests','floorMiB'):
   s=copy.deepcopy(SNAP);s['pool'][k]+=1
   self.assertTrue(F.snapshot_changes(SNAP,s))
 def test_concurrent_throughput_uses_wall_time(self):
  h={'seq':0,'arm':'B','outcome':'success','cleanup':'clean','requests':[{'round':2,'step':'parallel','wall_s':2,'results':[{'ok':True,'body':{'tokens':[1,2,3],'decode_ms':1000}}]*2}]}
  x=F.summarize([h])['0-B']
  self.assertEqual(x['steps'][0]['completed_tokens_per_wall_s'],2)
  self.assertIn('decode_tok_s_weighted_per_request',x)
if __name__=='__main__':unittest.main()

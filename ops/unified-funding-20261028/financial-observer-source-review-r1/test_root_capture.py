import sys,unittest
from pathlib import Path
P=Path('/home/steven/Documents/Codex/2026-10-23/it/work/restore-queued-20261028/session-quiescence/checkpoint-observer-candidate')
sys.path.insert(0,str(P))
from test_financial_trace_normalizer import TRACE,CONTEXT
from financial_trace_normalizer import normalize
class CaptureTests(unittest.TestCase):
 def test_raw_path_mutation_must_not_be_ignored(self):
  anchor=b'252795 1793232541.314647 close(0x5)'
  self.assertEqual(TRACE.count(anchor),1)
  raw=b'252795 1793232541.314600 rename(0x1234, 0x5678) = 0 <0.000010>\n'
  r=normalize(TRACE.replace(anchor,raw+anchor),CONTEXT)
  self.assertFalse(r['syscallCheckpoint'],'raw rename can target the journal; capture format must refuse it')
 def test_raw_open_must_not_bypass_role_mapping(self):
  anchor=b'252795 1793232541.314647 close(0x5)'
  raw=b'252795 1793232541.314600 openat(0xffffff9c, 0x1234, 0x241, 0x180) = 14 <0.000010>\n'
  r=normalize(TRACE.replace(anchor,raw+anchor),CONTEXT)
  self.assertFalse(r['syscallCheckpoint'],'required path decoding is missing; do not infer unrelated filesystem IO')
if __name__=='__main__':unittest.main()

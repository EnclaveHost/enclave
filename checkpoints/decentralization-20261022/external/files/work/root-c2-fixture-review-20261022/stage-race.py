from pathlib import Path
import importlib.util,tempfile,os,json
from unittest.mock import patch
p=Path('work/claude-resumed-20261022/storage-enclave-fixture/fixture/c2fx.py')
s=importlib.util.spec_from_file_location('fx',p); m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Docker:
 def labels(self,*a):return None
with tempfile.TemporaryDirectory() as t:
 r=m.Run(Path(t)/'runs',Docker(),run_id='stage-collision-proof')
 original=os.mkdir
 def race(path,*a,**kw):
  if Path(path)==r.stage:
   original(path,*a,**kw)
   (r.stage/'other-run.txt').write_text('belongs to another run')
   raise FileExistsError('simulated race after existence check')
  return original(path,*a,**kw)
 with patch('os.mkdir',race):
  try:r.begin()
  except FileExistsError:pass
 assert (r.stage/'other-run.txt').exists()
 result=r.cleanup()
 out={'bugReproduced':not (r.stage/'other-run.txt').exists(),'cleanup':result,'scope':'temporary mock stage only; no Docker, subprocess or production changes'}
 Path(__file__).with_suffix('.json').write_text(json.dumps(out,indent=2)+'\n')
 print(json.dumps(out))
 assert not out['bugReproduced'],'cleanup deleted a raced stage it did not create'

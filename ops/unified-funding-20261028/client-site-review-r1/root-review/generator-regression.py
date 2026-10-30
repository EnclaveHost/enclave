import runpy
from pathlib import Path
g=runpy.run_path(str(Path(__file__).resolve().parents[1]/"generator/generate.py"))
bad=[]
for target,(_,edits) in g["PATCHES"].items():
 for a,b in edits:
  if a not in b: bad.append(target+": "+a)
assert not bad, "Generator rejects its own declared patches: "+repr(bad)

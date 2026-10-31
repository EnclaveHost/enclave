from pathlib import Path
import hashlib,json,time
from capture_local import capture
p=Path(__file__).resolve().parent;pins=json.loads((p/'PINS.json').read_text())
def verify():
 for name,pin in pins.items():assert hashlib.sha256((p/name).read_bytes()).hexdigest()==pin
verify()
with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'dummyOnly':True,'controllerMiB':128,'maximumActorsMiB':128,'totalReservationMiB':256},f)
r=capture(['/usr/bin/python3','-I','-B',str(p/'qualify_activation_dependencies.py'),'controller',str(p/'case')],30,limit=65536)
(p/'RESULT.json').write_text(json.dumps(r,indent=2)+'\n');verify()
assert r['rc']==0 and not r['reason'] and not r['truncated'],'Native dependency fixture failed; preserve result'

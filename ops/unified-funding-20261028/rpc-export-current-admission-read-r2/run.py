from pathlib import Path
import json,hashlib,time
from capture_local import capture
p=Path(__file__).resolve().parent;pins=json.loads((p/'PINS.json').read_text())
def verify():
 for n,h in pins.items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h,n
verify()
with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'readOnly':True,'newMaintainedObserverQualification':False,'reason':'one fresh admission after completed owner delivery and target staging; previous capacity observation is historical'},f)
r=capture(['/usr/bin/node',str(p/'observe_resources.mjs'),str(p/'CONFIG.json')],3,limit=32768)
(p/'RESULT.json').write_text(json.dumps(r,indent=2)+'\n');verify();assert r['rc']==0 and not r['reason'] and not r['truncated']
row=json.loads(r['stdout']);assert row['authenticated'] and r['elapsedSeconds']<1.5

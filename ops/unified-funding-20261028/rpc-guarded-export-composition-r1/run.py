from pathlib import Path
import json,hashlib,subprocess,os
from capture_local import capture
p=Path(__file__).resolve().parent;s=p.parent.parent/'source'
pins=json.loads((p/'PINS.json').read_text())
def verify():
 for name,sha in pins.items():
  with Path(name).open('rb') as f:assert hashlib.file_digest(f,'sha256').hexdigest()==sha,name
verify()
cfg=json.loads((p/'CONFIG.json').read_text())
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),cfg['resourceConfig']['path']],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-1280>=max(27648,a['floorMiB'])
(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
with (p/'INTENT.json').open('x')as f:json.dump({'dummyDataOnly':True,'productionData':False,'oneNativeAttempt':True},f);f.flush();os.fsync(f.fileno())
r=capture(['/usr/bin/python3','-B',str(s/'test/rpc-server/qualify_guarded_export.py'),str(p/'CONFIG.json')],65,limit=65536)
(p/'RUN-RESULT.json').write_text(json.dumps(r,indent=2)+'\n');verify()
assert r['rc']==0 and not r['reason'] and not r['truncated']
row=json.loads(r['stdout']);assert row['allPass'] and row['exactFourPidfdsExited']
(p/'RESULT.json').write_text(json.dumps(row,indent=2)+'\n')

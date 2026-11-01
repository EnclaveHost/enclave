from pathlib import Path
import json,hashlib,subprocess,os
p=Path(__file__).resolve().parent;s=p.parent.parent/'source'
assert os.sched_getaffinity(0)=={1}
for name,h in json.loads((p/'PINS.json').read_text()).items():assert hashlib.sha256(Path(name).read_bytes()).hexdigest()==h
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-384>=max(27648,a['floorMiB']);(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
with (p/'read.log').open('x') as log:r=subprocess.run(['/usr/bin/node','--max-old-space-size=128',str(p/'read.mjs')],stdout=log,stderr=log,timeout=60)
(p/'EXIT.json').write_text(json.dumps({'code':r.returncode})+'\n')
for name,h in json.loads((p/'PINS.json').read_text()).items():assert hashlib.sha256(Path(name).read_bytes()).hexdigest()==h
raise SystemExit(r.returncode)

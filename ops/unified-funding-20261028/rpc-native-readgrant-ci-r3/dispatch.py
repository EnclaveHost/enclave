from pathlib import Path
import subprocess,json,time,hashlib
p=Path(__file__).resolve().parent
s=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source')
head='0b1dc2e78aa69d9e91c592c67cde5bfbce45b7ea'
pins=json.loads((p/'SOURCE-PINS.json').read_text())
for n,h in pins.items():assert hashlib.sha256((s/n).read_bytes()).hexdigest()==h,n
a=json.loads(subprocess.check_output(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],text=True,timeout=3))
assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-384>=max(27648,a['floorMiB'])
(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
assert subprocess.check_output(['git','ls-remote','origin','refs/heads/main'],cwd=s,text=True,timeout=20).split()[0]==head
with (p/'DISPATCH-INTENT.json').open('x') as f:json.dump({'at':time.time(),'head':head,'workflow':'rpc-native-readgrant.yml','noRetry':True},f)
try:
 r=subprocess.run(['/usr/sbin/gh','workflow','run','rpc-native-readgrant.yml','--repo','EnclaveHost/enclave','--ref','main','-f','expected_sha='+head],capture_output=True,text=True,timeout=30)
 (p/'DISPATCH-RESULT.json').write_text(json.dumps({'head':head,'rc':r.returncode,'stdout':r.stdout[:4096],'stderr':r.stderr[:4096]},indent=2)+'\n')
 raise SystemExit(r.returncode)
except subprocess.TimeoutExpired:
 (p/'DISPATCH-UNKNOWN.json').write_text(json.dumps({'head':head,'unknown':True,'noRetry':True})+'\n')
 raise

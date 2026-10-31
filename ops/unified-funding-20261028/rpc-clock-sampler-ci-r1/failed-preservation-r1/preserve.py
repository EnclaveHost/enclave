from pathlib import Path
import subprocess,json
s=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source');p=Path(__file__).resolve().parent
paths=['windows/rpc/README.md','ops/unified-funding-20261028/rpc-clock-sampler-ci-r1']
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(s.parent/'unified-funding-20261028/rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-384>=max(27648,a['floorMiB'])
(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
with (p/'PUSH.log').open('x') as log:
 def run(args):return subprocess.run(args,cwd=s,stdout=log,stderr=log,check=True,timeout=120)
 run(['git','add','--']+paths)
 run(['git','diff','--cached','--check'])
 run(['git','commit','-m','Preserve actual Windows clock sampler qualification and source pins'])
 run(['git','push','origin','HEAD:main'])
 head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=s,text=True).strip()
 remote=subprocess.check_output(['git','ls-remote','origin','refs/heads/main'],cwd=s,text=True,timeout=30).split()[0]
 (p/'PUSH-RESULT.json').write_text(json.dumps({'head':head,'remote':remote,'match':head==remote})+'\n')
 assert head==remote

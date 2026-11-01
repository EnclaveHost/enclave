from pathlib import Path
import subprocess,json,hashlib
s=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source');p=Path(__file__).resolve().parent
paths=json.loads((p/'PATHS.json').read_text())
for n,h in json.loads((p/'SOURCE-FREEZE.json').read_text()).items():assert hashlib.sha256((s/n).read_bytes()).hexdigest()==h,n
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(s.parent/'unified-funding-20261028/rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-384>=max(27648,a['floorMiB'])
(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
with (p/'PUSH.log').open('x') as log:
 def run(args):return subprocess.run(args,cwd=s,stdout=log,stderr=log,check=True,timeout=120)

 for q in [p,p.parent/'rpc-native-media-ci-r1']:
  out=s/'ops/unified-funding-20261028'/q.name;out.mkdir(parents=True,exist_ok=True)
  for f in q.iterdir():
   if f.is_file() and f.suffix in ['.json','.md','.py']:(out/f.name).write_bytes(f.read_bytes())
 assert subprocess.check_output(['git','rev-parse','origin/main'],cwd=s,text=True).strip()=='7bcfccbb8126dc1e555f32c2451d966c0db0616b'
 run(['git','add','--']+paths)
 run(['git','diff','--cached','--check'])
 run(['git','commit','-m','Bind native RPC optical media to original profile and private custody'])
 run(['git','push','origin','HEAD:main'])
 head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=s,text=True).strip()
 remote=subprocess.check_output(['git','ls-remote','origin','refs/heads/main'],cwd=s,text=True,timeout=30).split()[0]
 (p/'PUSH-RESULT.json').write_text(json.dumps({'head':head,'remote':remote,'match':head==remote})+'\n')
 assert head==remote

from pathlib import Path
import subprocess,json
s=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source');p=Path(__file__).resolve().parent
paths=['network/deployment-serving-permit.mjs', 'network/deployment-permit-gate.mjs', 'network/deployment-lifecycle-witness.mjs', 'network/deployment-isolation-runtime.mjs', 'network/deployment-owned-host-services.mjs', 'test/deployment-owned-host-services.test.mjs', 'test/helpers/owned-host-services-fixture.mjs', 'test/helpers/owned-host-services-failure-child.mjs', 'docs/design/decentralized-lifecycle-rollout.md', 'ops/unified-funding-20261028/lifecycle-owned-services-main-tests-r1', 'ops/unified-funding-20261028/lifecycle-owned-services-main-tests-r2', 'ops/unified-funding-20261028/lifecycle-owned-services-main-tests-r3', 'ops/unified-funding-20261028/lifecycle-owned-services-main-preserve-r1']
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(s.parent/'unified-funding-20261028/rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-384>=max(27648,a['floorMiB'])
(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
with (p/'PUSH.log').open('x') as log:
 def run(args):return subprocess.run(args,cwd=s,stdout=log,stderr=log,check=True,timeout=120)
 run(['git','add','--']+paths)
 run(['git','diff','--cached','--check'])
 run(['git','commit','-m','Bind owned host services to exact authority and completed withdrawal'])
 run(['git','push','origin','HEAD:main'])
 head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=s,text=True).strip()
 remote=subprocess.check_output(['git','ls-remote','origin','refs/heads/main'],cwd=s,text=True,timeout=30).split()[0]
 (p/'PUSH-RESULT.json').write_text(json.dumps({'head':head,'remote':remote,'match':head==remote})+'\n')
 assert head==remote

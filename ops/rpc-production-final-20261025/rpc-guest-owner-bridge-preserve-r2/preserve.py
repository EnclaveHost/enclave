from pathlib import Path
import subprocess,json
s=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source');p=Path(__file__).resolve().parent
paths=json.loads((p/'PATHS.json').read_text())
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(s.parent/'unified-funding-20261028/rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-384>=max(27648,a['floorMiB'])
(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')

import tempfile,secrets,shutil
rel='ops/rpc-production-final-20261025/rpc-guest-owner-bridge-tests-r2/owner-offer-vector.json'
vector=(s/rel).read_bytes();cfg=s/'.gitleaks.toml';checks=[]
for case,want in [('public',0),('changed-ciphertext',1),('other-path',1),('private-key',1)]:
 with tempfile.TemporaryDirectory(prefix='rpc-scan-') as td:
  root=Path(td);f=root/(rel if case!='other-path' else 'unrelated.json');f.parent.mkdir(parents=True,exist_ok=True);data=vector
  if case=='changed-ciphertext':
   value=json.loads(vector);offer=value['proof']['offer'] if 'proof' in value else value['offer'];offer['secret']=__import__('base64').b64encode(secrets.token_bytes(256)).decode();data=json.dumps(value).encode()
  if case=='private-key':data+=('\nprivateKey = "'+secrets.token_hex(32)+'"\n').encode()
  f.write_bytes(data)
  scan=subprocess.run(['/home/steven/.local/bin/gitleaks','dir',str(root),'--config',str(cfg),'--no-banner','--redact','--exit-code','1'],capture_output=True,timeout=30)
  assert scan.returncode==want,(case,scan.returncode)
  checks.append({'case':case,'exit':scan.returncode,'expected':want})
(s/'ops/rpc-production-final-20261025/rpc-guest-owner-bridge-preserve-r1/SCANNER-CHECK.json').write_text(json.dumps(checks,indent=2)+'\n')
with (p/'PUSH.log').open('x') as log:
 def run(args):return subprocess.run(args,cwd=s,stdout=log,stderr=log,check=True,timeout=120)
 run(['git','add','--']+paths)
 run(['git','diff','--cached','--check'])
 run(['git','commit','-m','Classify exact public TPM ciphertext fixture for secret scanning'])
 run(['git','push','origin','HEAD:main'])
 head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=s,text=True).strip()
 remote=subprocess.check_output(['git','ls-remote','origin','refs/heads/main'],cwd=s,text=True,timeout=30).split()[0]
 (p/'PUSH-RESULT.json').write_text(json.dumps({'head':head,'remote':remote,'match':head==remote})+'\n')
 assert head==remote

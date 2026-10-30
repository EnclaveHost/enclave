from pathlib import Path
import json,hashlib,subprocess,os
p=Path('/home/steven/Documents/Codex/2026-10-23/it/work/wallet-release-ui-r1-20261029')
sha=lambda f:hashlib.sha256(f.read_bytes()).hexdigest()
prep=json.loads((p/'PREPARED.json').read_text())
assert sha(p/'PREPARED.json')=='a9e699a69955633fb5e0a15d61efbafa84decb3289dff8184f446a17c2874e00'
assert not (p/'attempt.json').exists()
for n,h in prep['hashes'].items():assert sha(p/n)==h,n
pins=json.loads((p/'input-pins.json').read_text())
for n,h in pins.items():assert sha(Path(n))==h,n
seed=json.loads((p/'seed-pins.json').read_text())
for n,h in seed.items():assert sha(p/'candidate'/n)==sha(p/'seed'/n)==h,n
assert {str(f.relative_to(p/'candidate')) for f in (p/'candidate').rglob('*') if f.is_file()}==set(seed)
exe=Path(prep['claudeExecutable']['path']);assert sha(exe)==prep['claudeExecutable']['sha256']
a=json.loads(subprocess.check_output([str(exe),'auth','status'],text=True,timeout=20))
assert a.get('loggedIn') and a.get('email')=='steven.r.batchelor@gmail.com' and a.get('subscriptionType')=='max'
print(json.dumps({'readonlyPins':len(pins),'seedFiles':len(seed),'drift':0,'account':{k:a.get(k) for k in ['loggedIn','email','subscriptionType']},'preparedSha256':sha(p/'PREPARED.json'),'executableSha256':sha(exe)}))

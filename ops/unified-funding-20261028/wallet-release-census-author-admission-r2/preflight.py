from pathlib import Path
import json,hashlib,subprocess
p=Path('/home/steven/Documents/Codex/2026-10-23/it/work/wallet-release-census-r2-20261029')
def sha(f):return hashlib.sha256(Path(f).read_bytes()).hexdigest()
assert sha(p/'PREPARED.json')=='cfa72e246f89e682064cf71354cf1cea98f0db6cc0a6b3e6bb8f01b38b88933d'
j=json.loads((p/'PREPARED.json').read_text())
for n,h in j['hashes'].items():assert sha(p/n)==h,n
pins=json.loads((p/'input-pins.json').read_text())
for n,h in pins.items():assert sha(n)==h,n
seed=json.loads((p/'seed-pins.json').read_text());assert len(seed)==121
assert set(str(x.relative_to(p/'candidate')) for x in (p/'candidate').rglob('*') if x.is_file())==set(seed)
for n,h in seed.items():assert sha(p/'candidate'/n)==h,n
exe=j['claudeExecutable'];assert sha(exe['path'])==exe['sha256'];a=json.loads(subprocess.check_output([exe['path'],'auth','status'],text=True,timeout=20))
assert a.get('loggedIn') and a.get('email')=='steven.r.batchelor@gmail.com' and a.get('subscriptionType')=='max'
r={'account':{k:a.get(k)for k in ['loggedIn','email','subscriptionType']},'seedFiles':121,'readonlyPins':len(pins),'drift':0,'preparedSha256':sha(p/'PREPARED.json'),'sourceOnly':True}
Path(__file__).with_name('preflight-result.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))

from pathlib import Path
import hashlib,json,subprocess,sys
p=Path('/home/steven/Documents/Codex/2026-10-23/it/work/wallet-release-prod-r1-20261029')
def sha(f):
 h=hashlib.sha256()
 with Path(f).open('rb') as stream:
  for b in iter(lambda:stream.read(1048576),b''):h.update(b)
 return h.hexdigest()
assert len(sys.argv)==2 and sha(p/'PREPARED.json')==sys.argv[1]
j=json.loads((p/'PREPARED.json').read_text())
assert j['status']=='PREPARED_NOT_LAUNCHED'
assert not (p/'attempt.json').exists()
for n,h in j['hashes'].items():assert sha(p/n)==h,n
pins=json.loads((p/'input-pins.json').read_text())
for n,h in pins.items():assert sha(n)==h,n
seed=json.loads((p/'seed-pins.json').read_text());assert len(seed)==125
assert {str(x.relative_to(p/'candidate')) for x in (p/'candidate').rglob('*') if x.is_file()}==set(seed)
for n,h in seed.items():assert sha(p/'candidate'/n)==h,n
provenance=json.loads((p/'seed-provenance.json').read_text())
production=Path(provenance['productionRoot'])
assert {str(x.relative_to(production)) for x in production.rglob('*') if x.is_file()}==set(seed)
assert {n for n,h in seed.items() if sha(production/n)!=h}=={'enclave/test/wallet-release/census.test.mjs'}
assert sha(p/'candidate/enclave/test/wallet-release/census.test.mjs')=='8fbde14c5f700f54930191e2dbea0bab58ba72e7fce03a18ea59d05ae91587a1'
exe=j['claudeExecutable'];assert sha(exe['path'])==exe['sha256']
a=json.loads(subprocess.check_output([exe['path'],'auth','status'],text=True,timeout=20))
assert a.get('loggedIn') and a.get('email')=='steven.r.batchelor@gmail.com' and a.get('subscriptionType')=='max'
r={'account':{k:a.get(k) for k in ['loggedIn','email','subscriptionType']},'seedFiles':125,'readonlyPins':len(pins),'drift':0,'preparedSha256':sha(p/'PREPARED.json'),'sourceOnly':True,'productMatchesLive':True,'testOnlyOverlay':'census.test.mjs'}
Path(__file__).with_name('preflight-result.json').write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps(r))

from pathlib import Path
import json,hashlib,subprocess,time
p=Path(__file__).resolve().parent;s=p.parent.parent/'source';pins=json.loads((p/'PINS.json').read_text())
def verify():
 for n,h in pins.items():
  assert hashlib.sha256((p/'frozen'/n).read_bytes()).hexdigest()==h,n
  assert hashlib.sha256((s/n).read_bytes()).hexdigest()==h,n
verify()
assert hashlib.sha256((p.parent/'rpc-owner-composition-build-r1/output/TEST-ONLY-owner').read_bytes()).hexdigest()=='053a73e127fb17a1ac6a6030d1ac3b479829b513ca24f68b21b51560cfe370dd'
with (p/'DISPATCH-INTENT.json').open('x') as f:json.dump({'at':time.time(),'dummyOnly':True,'oneNativeQualification':True},f)
args=['/usr/bin/python3','-B',str(p/'frozen/test/rpc-server/qualify_owner_composition.py'),str(p/'private'),str(p/'public'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json'),str(p.parent/'rpc-owner-composition-build-r1/output/TEST-ONLY-owner')]
(p/'FIXTURE-COMMAND.json').write_text(json.dumps(args)+'\n')
begin=time.monotonic()
with (p/'output.txt').open('x') as out:r=subprocess.run(args,stdout=out,stderr=out,timeout=65)
verify();result={'exit':r.returncode,'elapsed':time.monotonic()-begin,'pinsUnchanged':True,'pins':len(pins)}
(p/'RESULT.json').write_text(json.dumps(result)+'\n');print(json.dumps(result));assert r.returncode==0

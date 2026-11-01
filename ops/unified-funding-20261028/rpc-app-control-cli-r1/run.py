from pathlib import Path
import json,hashlib,subprocess,time
p=Path(__file__).resolve().parent;s=p.parent.parent/'source';pins=json.loads((p/'PINS.json').read_text())
def verify():
 for n,h in pins.items():
  assert hashlib.sha256((p/'frozen'/n).read_bytes()).hexdigest()==h,n
  assert hashlib.sha256((s/n).read_bytes()).hexdigest()==h,n
verify()
with (p/'DISPATCH-INTENT.json').open('x') as f:json.dump({'at':time.time(),'dummyOnly':True,'oneNativeQualification':True},f)
args=['/usr/bin/python3','-B',str(p/'frozen/test/rpc-server/qualify_guarded_cli.py'),str(p/'private'),str(p/'public'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json'),'--app-control-loss']
(p/'FIXTURE-COMMAND.json').write_text(json.dumps(args)+'\n')
begin=time.monotonic()
with (p/'output.txt').open('x') as out:r=subprocess.run(args,stdout=out,stderr=out,timeout=65)
verify();result={'exit':r.returncode,'elapsed':time.monotonic()-begin,'pinsUnchanged':True,'pins':len(pins)}
(p/'RESULT.json').write_text(json.dumps(result)+'\n');print(json.dumps(result));assert r.returncode==0

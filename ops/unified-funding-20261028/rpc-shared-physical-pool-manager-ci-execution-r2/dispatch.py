from pathlib import Path
import subprocess,json,time,hashlib
p=Path(__file__).resolve().parent
s=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source')
head='4de7faccdd151b6d2135c22f2cdb2692e01aab0f'
pins=json.loads((p.parent/'rpc-shared-physical-pool-ci-admission-r3/SOURCE-PINS.json').read_text())
for n,h in pins.items():assert hashlib.sha256((s/n).read_bytes()).hexdigest()==h,n
with (p/'DISPATCH-INTENT.json').open('x') as f:json.dump({'at':time.time(),'head':head,'workflow':'rpc-manager-allocation.yml','noRetry':True},f)
try:
 r=subprocess.run(['/usr/sbin/gh','workflow','run','rpc-manager-allocation.yml','--repo','EnclaveHost/enclave','--ref','main','-f','expected_sha='+head],capture_output=True,text=True,timeout=30)
 (p/'DISPATCH-RESULT.json').write_text(json.dumps({'head':head,'rc':r.returncode,'stdout':r.stdout[:4096],'stderr':r.stderr[:4096]},indent=2)+'\n')
 raise SystemExit(r.returncode)
except subprocess.TimeoutExpired:
 (p/'DISPATCH-UNKNOWN.json').write_text(json.dumps({'head':head,'unknown':True,'noRetry':True})+'\n')
 raise

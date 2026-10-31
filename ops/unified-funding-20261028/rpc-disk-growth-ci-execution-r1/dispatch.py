from pathlib import Path
import subprocess,json,time,hashlib
p=Path(__file__).resolve().parent
s=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source')
head='31ece363a19ba4c43362c155f50ce9690fd450c6'
pins=json.loads((p.parent/'rpc-disk-growth-ci-admission-r1/SOURCE-PINS.json').read_text())
for n,h in pins.items():assert hashlib.sha256((s/n).read_bytes()).hexdigest()==h,n
with (p/'DISPATCH-INTENT.json').open('x') as f:json.dump({'at':time.time(),'head':head,'workflow':'rpc-startup-cleanup.yml','noRetry':True},f)
try:
 r=subprocess.run(['/usr/sbin/gh','workflow','run','rpc-startup-cleanup.yml','--repo','EnclaveHost/enclave','--ref','main','-f','expected_sha='+head],capture_output=True,text=True,timeout=30)
 (p/'DISPATCH-RESULT.json').write_text(json.dumps({'head':head,'rc':r.returncode,'stdout':r.stdout[:4096],'stderr':r.stderr[:4096]},indent=2)+'\n')
 raise SystemExit(r.returncode)
except subprocess.TimeoutExpired:
 (p/'DISPATCH-UNKNOWN.json').write_text(json.dumps({'head':head,'unknown':True,'noRetry':True})+'\n')
 raise

from pathlib import Path
import hashlib,json,subprocess,os,time
p=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028/rpc-nan-cl-root-r8');q=Path(__file__).resolve().parent
assert os.sched_getaffinity(0)=={1}
sha=lambda f:hashlib.sha256(f.read_bytes()).hexdigest()
assert sha(p/'SOURCE-PINS.json')=='f33e5b584ffafb8bf3be4e91280946551e442ed7648722a4198973c831daf911'
pins=json.loads((p/'SOURCE-PINS.json').read_text());assert all(sha(p/n)==h for n,h in pins.items())
# The previous native recovery must already be terminal; do not overlap a second validation job.
r=subprocess.run(['/usr/bin/systemctl','--user','show','enclave-rpc-control-vm-l1-client-native-r7-20261030.service','-p','MainPID','-p','ActiveState'],capture_output=True,text=True,timeout=4)
v=dict(l.split('=',1) for l in r.stdout.splitlines() if '=' in l);assert v.get('MainPID')=='0' and v.get('ActiveState') in ('inactive','failed'),'EL-native-still-active'
with (q/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'sourceOnly':True,'pinsSha256':sha(p/'SOURCE-PINS.json')},f)
for script in ('check-source.py','assemble.py'):
 z=subprocess.run(['/usr/bin/python3','-B',str(p/script)],capture_output=True,text=True,timeout=45,env=dict(os.environ,PYTHONDONTWRITEBYTECODE='1'))
 (q/(script+'.json')).write_text(json.dumps({'rc':z.returncode,'stdout':z.stdout,'stderr':z.stderr},indent=2));assert z.returncode==0,script
assert all(sha(p/n)==h for n,h in pins.items())
r=p/'runtime';runtimepins=json.loads((r/'PINS.json').read_text());assert all(sha(r/n)==h for n,h in runtimepins.items())
m=json.loads((r/'MANIFEST.json').read_text());assert m['admission']['authorized'] is False and m['timingPolicy']['outerSeconds']==1000
(q/'RESULT.json').write_text(json.dumps({'sourceOnly':True,'passed':True,'sourceDrift':[],'runtimePinsSha256':sha(r/'PINS.json'),'nativeAdmitted':False},indent=2));print((q/'RESULT.json').read_text())

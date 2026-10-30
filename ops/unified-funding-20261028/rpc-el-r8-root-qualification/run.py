from pathlib import Path
import json,subprocess,time,os,hashlib
p=Path(__file__).resolve().parent;s=p.parent/'rpc-control-vm-l1-client-root-r8'
assert os.sched_getaffinity(0)=={1}
sha=lambda f:hashlib.sha256(f.read_bytes()).hexdigest()
assert sha(s/'SOURCE-PINS.json')=='f901dd16576ca256e68aaad052d3090dc84af797df9fcd02e2d7ad679a865bfb'
pins=json.loads((s/'SOURCE-PINS.json').read_text());assert all(sha(s/n)==h for n,h in pins.items())
r=subprocess.run(['/usr/bin/systemctl','--user','show','enclave-rpc-nan-cl-native-n8-20261030.service','-p','MainPID','-p','ActiveState'],capture_output=True,text=True,timeout=4);v=dict(l.split('=',1) for l in r.stdout.splitlines() if '=' in l);assert v.get('MainPID')=='0' and v.get('ActiveState') in ('inactive','failed'),'Nan-native-still-active'
with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'sourceOnly':True,'native':False},f)
for name in ['check-source.py','assemble.py','check-runtime.py']:
 r=subprocess.run(['/usr/bin/python3','-B',str(s/name)],capture_output=True,text=True,timeout=45,env=dict(os.environ,PYTHONDONTWRITEBYTECODE='1'))
 (p/(name+'.json')).write_text(json.dumps({'rc':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2));assert r.returncode==0,name
assert all(sha(s/n)==h for n,h in pins.items())
(p/'RESULT.json').write_text(json.dumps({'sourceOnly':True,'passed':True,'sourceDrift':[],'runtimePinsSha256':sha(s/'runtime/PINS.json'),'nativeAdmitted':False},indent=2));print((p/'RESULT.json').read_text())

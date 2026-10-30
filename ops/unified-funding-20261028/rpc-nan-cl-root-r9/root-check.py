from pathlib import Path
import hashlib,json,os,subprocess
p=Path(__file__).resolve().parent
assert os.sched_getaffinity(0)=={1}
sha=lambda f:hashlib.file_digest(f.open('rb'),'sha256').hexdigest()
pins=json.loads((p/'SOURCE-PINS.json').read_text())
assert all(sha(p/n)==h for n,h in pins.items())
for name in ('check-source.py','assemble.py'):
 r=subprocess.run(['/usr/bin/python3','-B',str(p/name)],capture_output=True,text=True,timeout=45)
 (p/('ROOT-'+name+'.json')).write_text(json.dumps({'rc':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2)+'\n')
 assert r.returncode==0,name
assert all(sha(p/n)==h for n,h in pins.items())
r=p/'runtime';m=json.loads((r/'MANIFEST.json').read_text());q=json.loads((r/'PINS.json').read_text())
assert all(sha(r/n)==h for n,h in q.items())
assert m['admission']['authorized'] is False
assert m['timingPolicy']['outerSeconds']==2500
(p/'ROOT-QUALIFIED.json').write_text(json.dumps({'sourceOnly':True,'native':False,'sourcePins':sha(p/'SOURCE-PINS.json'),'runtimePins':sha(r/'PINS.json'),'inputDrift':[]},indent=2)+'\n')

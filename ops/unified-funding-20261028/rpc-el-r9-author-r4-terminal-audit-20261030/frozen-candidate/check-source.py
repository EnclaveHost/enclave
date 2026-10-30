from pathlib import Path
import json,hashlib,os,subprocess
p=Path(__file__).resolve().parent
assert os.sched_getaffinity(0)=={1}
sha=lambda q:hashlib.sha256(q.read_bytes()).hexdigest()
pins=json.loads((p/'SOURCE-PINS.json').read_text());assert all(sha(p/n)==h for n,h in pins.items())
with (p/'CHECK-ATTEMPT.json').open('x') as f:json.dump({'sourceOnly':True,'native':False},f)
r=subprocess.run(['/usr/bin/python3','-B',str(p/'test_source.py')],capture_output=True,text=True,timeout=30,env=dict(os.environ,PYTHONDONTWRITEBYTECODE='1'))
result={'rc':r.returncode,'stdout':r.stdout,'stderr':r.stderr,'inputDrift':[n for n,h in pins.items() if sha(p/n)!=h]}
(p/'CHECK-RESULT.json').write_text(json.dumps(result,indent=2)+'\n');print(r.stdout,r.stderr)
assert not result['inputDrift'];raise SystemExit(r.returncode)

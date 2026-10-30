from pathlib import Path
import hashlib,json,os,subprocess,sys,tempfile
p=Path(__file__).resolve().parent
assert os.sched_getaffinity(0)=={1}
sha=lambda f:hashlib.file_digest(f.open('rb'),'sha256').hexdigest()
pins=json.loads((p/'SOURCE-PINS.json').read_text());assert all(sha(p/n)==h for n,h in pins.items())
with (p/'CHECK-ATTEMPT.json').open('x') as f:json.dump({'sourceOnlyFixtures':True,'native':False},f)
env=dict(os.environ,PYTHONDONTWRITEBYTECODE='1')
r=subprocess.run(['/usr/bin/python3','-B',str(p/'test_source.py')],text=True,capture_output=True,timeout=30,env=env)
(p/'CHECK-RESULT.json').write_text(json.dumps({'rc':r.returncode,'stdout':r.stdout,'stderr':r.stderr,'inputDrift':[n for n,h in pins.items() if sha(p/n)!=h]},indent=2)+'\n');print(r.stdout,r.stderr)
raise SystemExit(r.returncode)

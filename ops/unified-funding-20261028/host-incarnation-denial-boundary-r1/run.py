from pathlib import Path
import os, subprocess, hashlib, json
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
pins=json.loads((p/'input-pins.json').read_text())
check=lambda:all(hashlib.sha256(Path(n).read_bytes()).hexdigest()==h for n,h in pins.items())
assert check(),'input drift'
with (p/'tests.log').open('x') as f:
 r=subprocess.run(['node','--test','--test-concurrency=1',str(p/'baseline.test.mjs')],stdout=f,stderr=subprocess.STDOUT,timeout=30)
assert check(),'input drift after test'
(p/'tests.rc').write_text(str(r.returncode)+'\n')
raise SystemExit(r.returncode)

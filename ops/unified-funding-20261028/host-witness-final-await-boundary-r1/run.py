from pathlib import Path
import os,subprocess,hashlib,json
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
pins=json.loads((p/'input-pins.json').read_text())
def check():
 for source,h in pins.items():
  assert hashlib.sha256(Path(source).read_bytes()).hexdigest()==h
  assert hashlib.sha256((p/'network'/Path(source).name).read_bytes()).hexdigest()==h
 assert hashlib.sha256((p/'final-await.test.mjs').read_bytes()).hexdigest()==(p/'test.sha256').read_text().strip()
check()
with (p/'tests.log').open('x') as f:
 r=subprocess.run(['unshare','-Urn','node','--test','--experimental-test-isolation=none','--test-concurrency=1',str(p/'final-await.test.mjs')],stdout=f,stderr=subprocess.STDOUT,timeout=45)
check()
(p/'tests.rc').write_text(str(r.returncode)+'\n')
raise SystemExit(r.returncode)

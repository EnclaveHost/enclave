from pathlib import Path
import os,subprocess,hashlib,json
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
pins=json.loads((p/'journal-lifetime-pins.json').read_text())
def check():
 for n,h in pins.items():assert hashlib.sha256(Path(n).read_bytes()).hexdigest()==h,n
check()
with (p/'journal-lifetime.log').open('x') as f:r=subprocess.run(['unshare','-Urn','node','--test','--experimental-test-isolation=none','--test-concurrency=1',str(p/'protocol-tree/journal-lifetime.test.mjs')],stdout=f,stderr=subprocess.STDOUT,timeout=80)
check()
(p/'journal-lifetime.rc').write_text(str(r.returncode)+'\n')
raise SystemExit(r.returncode)

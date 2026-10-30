from pathlib import Path
import os,subprocess,json,hashlib
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
m=json.loads((p/'source-pins.json').read_text())
def check():
 for n,h in m.items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h,n
check()
with (p/'result.tap').open('x') as f:
 r=subprocess.run(['unshare','-Urn','node','--max-old-space-size=100','--test','--experimental-test-isolation=none','--test-concurrency=1','--test-timeout=10000',str(p/'root.test.mjs')],stdout=f,stderr=subprocess.STDOUT,timeout=30)
check();(p/'result.rc').write_text(str(r.returncode)+'\n');raise SystemExit(r.returncode)

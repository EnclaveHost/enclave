from pathlib import Path
import os,subprocess,json,hashlib
p=Path(__file__).resolve().parent;os.sched_setaffinity(0,{min(os.sched_getaffinity(0))});m=json.loads((p/'pins.json').read_text())
def check():
 for f,h in m.items():assert hashlib.sha256(Path(f).read_bytes()).hexdigest()==h,f
check(); codes={}
for label,file in [('async','test/root-async-ownership-r4.test.mjs'),('independent','test-root.mjs')]:
 with (p/(label+'.log')).open('x') as f:
  r=subprocess.run(['unshare','-Urn','node','--max-old-space-size=240','--test','--experimental-test-isolation=none','--test-concurrency=1',str(p/'protocol'/file)],stdout=f,stderr=subprocess.STDOUT,timeout=90)
 codes[label]=r.returncode
check();(p/'results.json').write_text(json.dumps(codes,indent=2)+'\n');raise SystemExit(int(any(codes.values())))

from pathlib import Path
import os,subprocess,json,hashlib
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
m=json.loads((p/'source-pins.json').read_text())
def check():
 for n,h in m.items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h,n
check()
os.environ["TMPDIR"]=str(p/"persistent-test-tmp")
with (p/'router-persistent-result.tap').open('x') as f:
 r=subprocess.run(['unshare','-Urn','bash','-c','ip link set lo up && exec node --max-old-space-size=100 --test --experimental-test-isolation=none --test-concurrency=1 --test-timeout=75000 "$1"/candidate/test/windows-permit/router-protected.test.mjs','owned-author-tests',str(p)],stdout=f,stderr=subprocess.STDOUT,timeout=75)
check();(p/'router-persistent-result.rc').write_text(str(r.returncode)+'\n');raise SystemExit(r.returncode)

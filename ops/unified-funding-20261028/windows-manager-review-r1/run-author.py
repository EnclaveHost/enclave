from pathlib import Path
import os,subprocess,json,hashlib
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
m=json.loads((p/'source-pins.json').read_text())
def check():
 for n,h in m.items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h,n
check()
with (p/'author-result.tap').open('x') as f:
 r=subprocess.run(['unshare','-Urn','bash','-c','ip link set lo up && exec node --max-old-space-size=100 --test --experimental-test-isolation=none --test-concurrency=1 --test-timeout=240000 "$1"/candidate/test/windows-permit/*.test.mjs','owned-author-tests',str(p)],stdout=f,stderr=subprocess.STDOUT,timeout=240)
check();(p/'author-result.rc').write_text(str(r.returncode)+'\n');raise SystemExit(r.returncode)

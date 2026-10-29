from pathlib import Path
import os,subprocess,hashlib,json
p=Path(__file__).resolve().parent;os.sched_setaffinity(0,{min(os.sched_getaffinity(0))});m=json.loads((p/'pins.json').read_text())
def check():
 for f,h in m.items():assert hashlib.sha256((p/f).read_bytes()).hexdigest()==h,f
check()
with (p/'result.tap').open('x') as f:r=subprocess.run(['unshare','-Urn','bash','-c','ip link set lo up && exec node --max-old-space-size=100 --test --experimental-test-isolation=none --test-concurrency=1 "$1"','owned-manager-test',str(p/'test.mjs')],stdout=f,stderr=subprocess.STDOUT,timeout=35)
check();(p/'result.rc').write_text(str(r.returncode)+'\n');raise SystemExit(r.returncode)

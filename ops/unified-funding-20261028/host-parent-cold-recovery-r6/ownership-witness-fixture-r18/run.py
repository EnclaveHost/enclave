from pathlib import Path
import os,subprocess,json,hashlib
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
m=json.loads((p/'pins.json').read_text())
def check():
 for f,h in m.items():assert hashlib.sha256(Path(f).read_bytes()).hexdigest()==h,f
check()
with (p/'driver.log').open('x') as f:r=subprocess.run(['unshare','-Urn','bash',str(p/'run-protocol.sh')],stdout=f,stderr=subprocess.STDOUT,timeout=390)
check();(p/'driver.rc').write_text(str(r.returncode)+'\n');raise SystemExit(r.returncode)

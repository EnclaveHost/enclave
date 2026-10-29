from pathlib import Path
import os,subprocess,hashlib,json
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
pins=json.loads((p/'native-pins.json').read_text())
def check():
 for n,h in pins.items():assert hashlib.sha256(Path(n).read_bytes()).hexdigest()==h,n
check()
with (p/'native-driver.log').open('x') as f:r=subprocess.run(['unshare','-Urn','bash',str(p/'run-native.sh')],stdout=f,stderr=subprocess.STDOUT,timeout=1100)
check()
(p/'native-driver.rc').write_text(str(r.returncode)+'\n')
raise SystemExit(r.returncode)

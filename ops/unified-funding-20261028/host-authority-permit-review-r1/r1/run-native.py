from pathlib import Path
import os,hashlib,subprocess,json
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
assert hashlib.sha256((p/'run-native-subset.sh').read_bytes()).hexdigest()=="3fd0025110df5a5f68bf05c837518f2e07f8728b755efec9ae93b2bebd08f7ed"
pins=json.loads((p/'author-input-pins.json').read_text())
manifest=json.loads((p/'author-manifest.json').read_text())
check=lambda:all(hashlib.sha256(Path(n).read_bytes()).hexdigest()==v for n,v in pins.items()) and all(hashlib.sha256((p/'author-snapshot'/n).read_bytes()).hexdigest()==v for n,v in manifest.items())
assert check()
with (p/'native-driver.log').open('x') as f:r=subprocess.run(['unshare','-Urn','bash',str(p/'run-native-subset.sh')],stdout=f,stderr=subprocess.STDOUT,timeout=1050)
assert check()
(p/'native-driver.rc').write_text(str(r.returncode)+'\n')
raise SystemExit(r.returncode)

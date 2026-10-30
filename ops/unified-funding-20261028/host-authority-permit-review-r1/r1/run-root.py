from pathlib import Path
import os,subprocess,hashlib,json
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
pins=json.loads((p/'protocol-input-pins.json').read_text())
check=lambda:all(hashlib.sha256(Path(n).read_bytes()).hexdigest()==h for n,h in pins.items())
assert check()
assert hashlib.sha256((p/'protocol-tree/test/root-permit-integration.test.mjs').read_bytes()).hexdigest()==(p/'root-test.sha256').read_text().strip()
with (p/'root-tests.log').open('x') as f:
 r=subprocess.run(['unshare','-Urn','node','--test','--experimental-test-isolation=none','--test-concurrency=1',str(p/'protocol-tree/test/root-permit-integration.test.mjs')],stdout=f,stderr=subprocess.STDOUT,timeout=100)
assert check()
(p/'root-tests.rc').write_text(str(r.returncode)+'\n')
raise SystemExit(r.returncode)

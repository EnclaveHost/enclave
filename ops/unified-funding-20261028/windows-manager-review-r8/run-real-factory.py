from pathlib import Path
import os,subprocess,json,hashlib,tempfile,shutil
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
m=json.loads((p/'source-pins.json').read_text()) | json.loads((p/'factory-dependency-pins.json').read_text())
def check():
 for n,h in m.items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h,n
check()
tmp=Path(tempfile.mkdtemp(prefix='r8-',dir='/home/steven/Documents/Codex/2026-10-18/wo/work'))
assert len(str(tmp/'permit-r1-123456'/'guard-12345678.sock').encode())<104
os.environ['TMPDIR']=str(tmp)
os.environ['TEST_TMPDIR']=str(tmp)
os.environ['ENCLAVE_R8_FACTORY_CANDIDATE']=str(p/'candidate')
os.environ['ENCLAVE_R18_NETWORK_ROOT']=str(p/'r18-factory-deps/network')
(p/'real-factory-temp-dir.json').write_text(json.dumps({'path':str(tmp),'purpose':'owned persistent test journals and short IPC'}))
try:
 with (p/'real-factory-result.tap').open('x') as f:
  r=subprocess.run(['unshare','-Urn','bash','-c','ip link set lo up && exec node --max-old-space-size=100 --import "$1"/test-liveness.mjs --test --experimental-test-isolation=none --test-concurrency=1 --test-timeout=15000 "$1"/real-owned-factory.test.mjs','owned-r4',str(p)],stdout=f,stderr=subprocess.STDOUT,timeout=35)
 check();(p/'real-factory-result.rc').write_text(str(r.returncode)+'\n')
finally:
 (p/'real-factory-remaining-test-files.json').write_text(json.dumps([str(x.relative_to(tmp)) for x in tmp.rglob('*')]))
 shutil.rmtree(tmp)
raise SystemExit(r.returncode)

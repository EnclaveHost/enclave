from pathlib import Path
import os,subprocess,json,hashlib,tempfile,shutil
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
m=json.loads((p/'source-pins.json').read_text())
def check():
 for n,h in m.items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h,n
check()
tmp=Path(tempfile.mkdtemp(prefix='r6-',dir='/home/steven/Documents/Codex/2026-10-18/wo/work'))
assert len(str(tmp/'permit-r1-123456'/'guard-12345678.sock').encode())<104
os.environ['TMPDIR']=str(tmp)
(p/'owner-release-temp-dir.json').write_text(json.dumps({'path':str(tmp),'purpose':'owned persistent test journals and short IPC'}))
try:
 with (p/'owner-release-result.tap').open('x') as f:
  r=subprocess.run(['unshare','-Urn','bash','-c','ip link set lo up && exec node --max-old-space-size=100 --import "$1"/test-liveness.mjs --test --experimental-test-isolation=none --test-concurrency=1 --test-timeout=180000 "$1"/root-owner-release.test.mjs','owned-r4',str(p)],stdout=f,stderr=subprocess.STDOUT,timeout=210)
 check();(p/'owner-release-result.rc').write_text(str(r.returncode)+'\n')
finally:
 (p/'owner-release-remaining-test-files.json').write_text(json.dumps([str(x.relative_to(tmp)) for x in tmp.rglob('*')]))
 shutil.rmtree(tmp)
raise SystemExit(r.returncode)

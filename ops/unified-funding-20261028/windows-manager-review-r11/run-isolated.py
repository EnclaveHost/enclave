from pathlib import Path
import os,subprocess,json,hashlib,tempfile,shutil
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
m=json.loads((p/'source-pins.json').read_text())
def check():
 for n,h in m.items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h,n
check()
tmp=Path(tempfile.mkdtemp(prefix='r11-',dir='/home/steven/Documents/Codex/2026-10-18/wo/work'))
assert len(str(tmp/'permit-r1-123456'/'guard-12345678.sock').encode())<104
os.environ['TMPDIR']=str(tmp)
(p/'isolated-temp-dir.json').write_text(json.dumps({'path':str(tmp),'purpose':'owned persistent test journals and short IPC'}))
try:
 with (p/'isolated-result.tap').open('x') as f:
  r=subprocess.run(['unshare','-Urn','bash','-c','ip link set lo up && exec node --max-old-space-size=100 --import "$1"/test-liveness.mjs --test --experimental-test-isolation=process --test-concurrency=1 --test-timeout=180000 "$1"/candidate/test/windows-permit/r4-supervisor-chain.test.mjs "$1"/root-fixture-r5-ownership-chain.test.mjs "$1"/candidate/test/windows-permit/r6-stage-revocation.test.mjs "$1"/candidate/test/windows-permit/r6-router-ownership.test.mjs "$1"/candidate/test/windows-permit/r7-*.test.mjs "$1"/candidate/test/windows-permit/r8-*.test.mjs "$1"/candidate/test/windows-permit/r9-*.test.mjs "$1"/candidate/test/windows-permit/r10-*.test.mjs "$1"/candidate/test/windows-permit/r11-*.test.mjs "$1"/root-policy-refresh.test.mjs "$1"/root-chain-send-boundary.test.mjs "$1"/root-restart-unknown.test.mjs "$1"/root-host-route-progress.test.mjs','owned-r9',str(p)],stdout=f,stderr=subprocess.STDOUT,timeout=210)
 check();(p/'isolated-result.rc').write_text(str(r.returncode)+'\n')
finally:
 (p/'isolated-remaining-test-files.json').write_text(json.dumps([str(x.relative_to(tmp)) for x in tmp.rglob('*')]))
 shutil.rmtree(tmp)
raise SystemExit(r.returncode)

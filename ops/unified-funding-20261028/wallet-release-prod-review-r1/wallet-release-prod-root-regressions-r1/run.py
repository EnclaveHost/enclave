from pathlib import Path
import os,subprocess,json,hashlib,tempfile,shutil
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{1})
m=json.loads((p/'test-pins.json').read_text())
def check():
 for n,h in m.items(): assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h,n
check()
tmp=Path(tempfile.mkdtemp(prefix='wallet-release-test-',dir='/home/steven/Documents/Codex/2026-10-18/wo/work'))
env=dict(os.environ,WALLET_CENSUS_LEDGER_CREATOR="0x120ba39e91395273496c4c7d065733c9db461dbb:1",TMPDIR=str(tmp),TEST_TMPDIR=str(tmp),WALLET_RELEASE_SDK_FIXTURE=str(p/'shipped-sessions.mjs'))
(p/'temp-dir.json').write_text(json.dumps({'path':str(tmp),'owned':True}))
files=[str(p/'candidate/enclave/test/wallet-release/prod-root.test.mjs')]
try:
 with (p/'result.tap').open('x') as f:
  r=subprocess.run(['unshare','-Urn','node','--max-old-space-size=180','--test','--test-concurrency=1','--test-timeout=90000',*files],stdout=f,stderr=subprocess.STDOUT,env=env,timeout=150)
 check();(p/'result.rc').write_text(str(r.returncode)+'\n')
finally:
 (p/'remaining-test-files.json').write_text(json.dumps([str(x.relative_to(tmp)) for x in tmp.rglob('*')]))
 shutil.rmtree(tmp)
raise SystemExit(r.returncode)

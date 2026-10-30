#!/usr/bin/env python3
import datetime,hashlib,json,pathlib,subprocess,sys,time,os
W=pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/client-integrity-next')
N=W.parents[1]/'native-provenance-audit-stage/reproduce/logs/r3-eeffcc9.rc'
Q='/home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py'
pins=json.loads((W/'root-queue/pins.json').read_text())
def checked():
 for name,want in pins.items():
  if hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()!=want:raise RuntimeError('Reviewed job changed: '+name)
def log(s):print(datetime.datetime.now(datetime.timezone.utc).isoformat(),s,flush=True)
log('Waiting for the four native reproduction phases; no compile/cache writes while waiting')
deadline=time.monotonic()+7200
while not N.exists():
 if time.monotonic()>deadline:raise SystemExit('Native wait timed out; no build launched')
 time.sleep(15)
checked()
log('Native final phase finished, rc='+N.read_text().strip()+'; independent M7 patch tests start under same shared queue')
env=dict(os.environ,CARGO_BUILD_JOBS='1')
for name,mib,cmd in [('prepare-fetch',1024,['bash',str(W/'jobs/prepare-fetch.sh')]),('test-offline',1536,['unshare','-rn','bash',str(W/'jobs/test-offline.sh')])]:
 for attempt in range(1,11):
  checked()
  log(name+' attempt '+str(attempt))
  with (W/f'logs/root-{name}-{attempt}.out').open('x') as out:
   rc=subprocess.run(['python3',Q,'--mib',str(mib),'--log',str(W/f'logs/root-{name}-{attempt}.guard'),'--',*cmd],stdout=out,stderr=subprocess.STDOUT,env=env).returncode
  (W/f'logs/root-{name}-{attempt}.rc').write_text(str(rc)+'\n')
  if rc!=98:break
  time.sleep(15)
 log(name+' rc='+str(rc))
 if rc:raise SystemExit(rc)
log('Both phases exit0; requires log/source/root review, NOT production activation')

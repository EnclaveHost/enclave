import hashlib, json, os, pathlib, time
P=pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025')
B=P.parent.parent/'outputs/rpc-production-final-20261025/base-multipart-production-20261026'
runner=P/'jobs/root-multipart-batches-1773.py'; want='5c33f6e24d0b880d47521c08a001c6b8d11af18cfcc044c411ef09a889ad410a'
assert hashlib.sha256(runner.read_bytes()).hexdigest()==want
assert (P/'logs/rmp-batches-1779-tests.rc').read_text().strip()=='0'
inputs=(P/'logs/rmp-batches-1779-tests-20261027T002511Z-2524817/inputs.sha256').read_text();assert want in inputs
out=B/'batches-1773-run1'
assert not out.exists()
(B/'continuation-watcher.json').write_text(json.dumps({'pid':os.getpid(),'atEpoch':time.time(),'runnerSha256':want,'waitsFor':'rmp-r3-batch-0001-0008-verify-1769.rc','start':9,'stop':264,'out':str(out),'stopBeforeActivation':'SIGTERM this watcher after checking PID identity','stopAfterActivation':'SIGTERM driver or create OUT/STOP; never kill queue groups'},indent=2)+'\n')
print('Waiting for existing part1..8 verification; no new recovery job started.',flush=True)
deadline=time.monotonic()+10800
rc=P/'logs/rmp-r3-batch-0001-0008-verify-1769.rc'
while not rc.exists():
 if time.monotonic()>deadline:raise SystemExit('Timed out waiting; no next batch started')
 time.sleep(10)
if rc.read_text().strip()!='0':raise SystemExit('Existing verification failed; no next batch started')
assert (P/'logs/rmp-r3-batch-0001-0008-copy-1762.rc').read_text().strip()=='0'
assert hashlib.sha256(runner.read_bytes()).hexdigest()==want
assert not out.exists()
print('Existing copy and verify jobs completed0; starting reviewed driver with fresh per-batch admission.',flush=True)
os.chdir(P)
os.execvp('python3',['python3','-I','-B',str(runner),'drive','--start','9','--runner-sha256',want,'--out',str(out)])

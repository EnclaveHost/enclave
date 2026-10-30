import pathlib,json,hashlib,subprocess,time,os,sys
m=pathlib.Path(__file__).resolve().parent
root=m.parents[2]
queue=root/'claude-test-queue.py'
assert queue.is_file(),queue
prior=m.parent/'client-integrity-next/production-build/recovery-4096/logs/root-resume-final.rc'
pins=json.loads((m/'root-input-pins.json').read_text())
status=m/'logs/root-run-4096-status.json'
def mark(s,**kw):
 status.write_text(json.dumps({'time':time.time(),'state':s,**kw},indent=2)+'\n')
def verify():
 for name,want in pins.items():
  assert hashlib.sha256((m/name).read_bytes()).hexdigest()==want,('frozen input changed',name)
verify();mark('waiting-for-4096-m7-build')
print('Waiting for active M7 production build to finish; no compiler started.',flush=True)
deadline=time.monotonic()+43200
while not prior.exists():
 if time.monotonic()>deadline:mark('wait-expired');sys.exit(98)
 time.sleep(30)
rc=int(prior.read_text().strip())
if rc!=0:mark('blocked-by-4096-m7-build-result',priorExit=rc);sys.exit(rc)
env=dict(os.environ,CARGO_BUILD_JOBS='1',RUSTFLAGS='-C link-arg=-Wl,--threads=1')
for attempt in range(1,181):
 verify()
 log=m/f'logs/root-after4096-test-m10-{attempt}.out'
 mark('attempting-guarded-tests',attempt=attempt)
 with log.open('x') as out:
  r=subprocess.run([sys.executable,str(queue),'--mib','1792','--log',str(m/f'logs/root-after4096-test-m10-{attempt}.guard'),'--',
                    'unshare','-rn','bash',str(m/'jobs/root-test-m10.sh')],env=env,stdout=out,stderr=subprocess.STDOUT)
 (m/f'logs/root-after4096-test-m10-{attempt}.rc').write_text(str(r.returncode)+'\n')
 if r.returncode==98:mark('waiting-for-test-lane',attempt=attempt);time.sleep(30);continue
 mark('tests-finished',attempt=attempt,exit=r.returncode)
 print('M10 tests finished, exit',r.returncode,flush=True)
 sys.exit(r.returncode)
mark('queue-wait-expired');sys.exit(98)

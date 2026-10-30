# PREPARED ONLY; coordinator reviews PREPARED.json and launches this one bounded invocation.
from pathlib import Path
import hashlib,json,os,subprocess,time
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
sha=lambda f:hashlib.sha256(Path(f).read_bytes()).hexdigest()
prep=json.loads((p/'PREPARED.json').read_text())
for rel,h in prep['hashes'].items():
 if sha(p/rel)!=h:raise SystemExit('prepared input drift: '+rel)
pins=json.loads((p/'input-pins.json').read_text())
def drift():return [n for n,h in pins.items() if not Path(n).is_file() or sha(n)!=h]
if drift():raise SystemExit('readonly input drift; no launch')
seed=json.loads((p/'seed-pins.json').read_text())
if len(seed)!=152 or any(sha(p/'candidate'/n)!=h for n,h in seed.items()):raise SystemExit('candidate152seed drift')
if {str(f.relative_to(p/'candidate')) for f in (p/'candidate').rglob('*') if f.is_file()}!=set(seed):raise SystemExit('unexpected candidate seed files')
tmp=p/'owned-tmp';st=tmp.lstat()
if tmp.is_symlink() or not tmp.is_dir() or st.st_uid!=os.getuid() or st.st_mode&0o077:raise SystemExit('owned private TMPDIR required')
kind=subprocess.check_output(['/usr/bin/stat','-f','-c','%t',str(tmp)],text=True,timeout=5).strip().lower()
if kind!='ef53':raise SystemExit('reviewed persistent ext TMPDIR required; got '+kind)
with (p/'attempt.json').open('x') as f:json.dump({'pid':os.getpid(),'at':time.time(),'authorStarted':False},f)
a=json.loads(subprocess.check_output(['/home/steven/.local/bin/claude','auth','status'],text=True,timeout=20))
if not a.get('loggedIn') or a.get('email')!='steven.r.batchelor@gmail.com' or a.get('subscriptionType')!='max':raise SystemExit('required Max account unavailable')
(p/'account-verification.json').write_text(json.dumps({k:a.get(k) for k in ['loggedIn','email','subscriptionType']})+'\n')
(p/'started.json').write_text(json.dumps({'pid':os.getpid(),'startedAt':time.time(),'inputHashes':pins,'freshSession':True,'tmpFilesystem':kind})+'\n')
env=dict(os.environ,TMPDIR=str(tmp),TEST_TMPDIR=str(tmp));rc=1
try:
 with (p/'claude.out').open('x') as out:
  r=subprocess.run(['/home/steven/.local/bin/claude','-p',(p/'TASK.txt').read_text(),'--safe-mode','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--permission-mode','dontAsk','--allowedTools','Read,Grep,Write','--tools','Read,Grep,Write','--max-turns','55','--output-format','json'],stdout=out,stderr=subprocess.STDOUT,timeout=1800,cwd=p,env=env)
  rc=r.returncode
except subprocess.TimeoutExpired:rc=124
finally:
 (p/'claude.rc').write_text(str(rc)+'\n');(p/'finished.json').write_text(json.dumps({'rc':rc,'finishedAt':time.time(),'inputDrift':drift()})+'\n')
raise SystemExit(rc)

from pathlib import Path
import json, os, subprocess, hashlib, time
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
if hashlib.sha256((p/'TASK.reviewed.txt').read_bytes()).hexdigest()!='052c353c97b373dec34b292a780ab5c6a980cb6f49fe1823f9a06546cd34b05d':
    raise SystemExit('Reviewed task drift')
pins=json.loads((p/'input-pins.json').read_text())
for path,digest in pins.items():
    if hashlib.sha256(Path(path).read_bytes()).hexdigest()!=digest: raise SystemExit('Qualified input drift: '+path)
a=json.loads(subprocess.check_output(['/home/steven/.local/bin/claude','auth','status'],text=True,timeout=20))
if not a.get('loggedIn') or a.get('email')!='steven.r.batchelor@gmail.com' or a.get('subscriptionType')!='max':
    raise SystemExit('Required Claude Max account not active')
(p/'account-verification.json').write_text(json.dumps({k:a.get(k) for k in ['loggedIn','email','subscriptionType']})+'\n')
(p/'started.json').write_text(json.dumps({'pid':os.getpid(),'startedAt':time.time(),'inputHashes':pins})+'\n')
rc=1
try:
    with (p/'claude.out').open('x') as out:
        r=subprocess.run(['/home/steven/.local/bin/claude','--resume','6864aa8d-dbe5-44e4-b730-ba8f08471376','--fork-session','-p',(p/'TASK.txt').read_text(),'--safe-mode','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--permission-mode','dontAsk','--allowedTools','Read,Grep,Write','--tools','Read,Grep,Write','--max-turns','45','--output-format','json'],stdout=out,stderr=subprocess.STDOUT,timeout=1500,cwd=p)
        rc=r.returncode
except subprocess.TimeoutExpired:
    rc=124
finally:
    drift=[path for path,digest in pins.items() if hashlib.sha256(Path(path).read_bytes()).hexdigest()!=digest]
    (p/'claude.rc').write_text(str(rc)+'\n')
    (p/'finished.json').write_text(json.dumps({'rc':rc,'finishedAt':time.time(),'inputDrift':drift})+'\n')
raise SystemExit(rc)

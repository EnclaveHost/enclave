from pathlib import Path
import json,subprocess,time,shlex
p=Path(__file__).resolve().parent
with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'readOnly':True,'noRetry':True},f)
argv=json.loads((p/'SSH.json').read_text());remote=json.loads((p/'REMOTE.json').read_text())
try:
 r=subprocess.run(argv+[shlex.join(remote)],capture_output=True,text=True,timeout=130)
except subprocess.TimeoutExpired as e:
 def txt(v):return v.decode('utf-8',errors='replace') if isinstance(v,bytes) else (v or '')
 (p/'TRANSPORT-TIMEOUT.json').write_text(json.dumps({'stdout':txt(e.stdout)[:262144],'stderr':txt(e.stderr)[:4096],'remoteDeathProven':False},indent=2)+'\n')
 raise
assert len(r.stdout)<262144 and len(r.stderr)<4096
out={'rc':r.returncode,'stderr':r.stderr,'readOnly':True}
if r.returncode==0:out['observation']=json.loads(r.stdout)
(p/'RESULT.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'rc':r.returncode}));raise SystemExit(r.returncode)

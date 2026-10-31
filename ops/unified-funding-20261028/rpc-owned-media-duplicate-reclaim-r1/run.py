from pathlib import Path
import json,subprocess,time,shlex
p=Path(__file__).resolve().parent
with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'readOnly':False,'noRetry':True},f)
import hashlib
source=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/storage-vm/image/noble-server-cloudimg-amd64.img')
with source.open('rb') as original:assert hashlib.file_digest(original,'sha256').hexdigest()=='04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94'
argv=json.loads((p/'SSH.json').read_text());remote=json.loads((p/'REMOTE.json').read_text())
try:
 r=subprocess.run(argv+[shlex.join(remote)],capture_output=True,text=True,timeout=45)
except subprocess.TimeoutExpired as e:
 def txt(v):return v.decode('utf-8',errors='replace') if isinstance(v,bytes) else (v or '')
 (p/'TRANSPORT-TIMEOUT.json').write_text(json.dumps({'stdout':txt(e.stdout)[:262144],'stderr':txt(e.stderr)[:4096],'remoteDeathProven':False},indent=2)+'\n')
 raise
assert len(r.stdout)<262144 and len(r.stderr)<4096
out={'rc':r.returncode,'stderr':r.stderr,'readOnly':False}
if r.returncode==0:out['observation']=json.loads(r.stdout)
(p/'RESULT.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'rc':r.returncode}));raise SystemExit(r.returncode)

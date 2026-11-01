from pathlib import Path
import json,subprocess,time,shlex
p=Path(__file__).resolve().parent
s=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source')
a=json.loads(subprocess.check_output(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(s.parent/'unified-funding-20261028/rpc-export-current-admission-read-r2/CONFIG.json')],text=True,timeout=3))
assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-384>=max(27648,a['floorMiB'])
(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'readOnly':True,'noRetry':True},f)
argv=json.loads((p/'SSH.json').read_text());remote=json.loads((p/'REMOTE.json').read_text())
try:
 r=subprocess.run(argv+[shlex.join(remote)],capture_output=True,text=True,timeout=45)
except subprocess.TimeoutExpired as e:
 def txt(v):return v.decode('utf-8',errors='replace') if isinstance(v,bytes) else (v or '')
 (p/'TRANSPORT-TIMEOUT.json').write_text(json.dumps({'stdout':txt(e.stdout)[:262144],'stderr':txt(e.stderr)[:4096],'remoteDeathProven':False},indent=2)+'\n')
 raise
assert len(r.stdout)<262144 and len(r.stderr)<4096
out={'rc':r.returncode,'stderr':r.stderr,'readOnly':True}
if r.returncode==0:out['observation']=json.loads(r.stdout)
(p/'RESULT.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'rc':r.returncode}));raise SystemExit(r.returncode)

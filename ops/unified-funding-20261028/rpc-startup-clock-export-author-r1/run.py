from pathlib import Path
import json,subprocess,time,hashlib
p=Path(__file__).resolve().parent
s=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source')
config=s.parent/'unified-funding-20261028/rpc-export-current-admission-read-r2/CONFIG.json'
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(config)],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout)
if a.get('authenticated') is not True or a.get('unreadUnits')!=0 or a['availableMiB']-a['pendingMiB']-1664<max(27648,a['floorMiB']):raise SystemExit('Author pending-aware floor refused')
(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
r=subprocess.run(['/home/steven/.local/bin/claude','auth','status'],capture_output=True,text=True,timeout=15,check=True)
a=json.loads(r.stdout)
public={k:a.get(k) for k in ('loggedIn','email','subscriptionType')}
(p/'AUTH.json').write_text(json.dumps(public)+'\n')
if not a.get('loggedIn') or a.get('email')!='steven.r.batchelor@gmail.com' or a.get('subscriptionType')!='max':raise SystemExit('Required Claude Max account not active')
with (p/'claude.out').open('x') as out:
 r=subprocess.run(['/home/steven/.local/bin/claude','-p',(p/'TASK.txt').read_text(),'--safe-mode','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--permission-mode','dontAsk','--allowedTools','Read,Grep,Write','--tools','Read,Grep,Write','--max-turns','30','--output-format','json'],stdout=out,stderr=subprocess.STDOUT,timeout=720,cwd=p)
(p/'claude.rc').write_text(str(r.returncode)+'\n')
raise SystemExit(r.returncode)

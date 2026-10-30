from pathlib import Path
import subprocess,json
p=Path(__file__).parent
a=json.loads(subprocess.check_output(['/home/steven/.local/bin/claude','auth','status'],text=True))
if not a.get('loggedIn') or a.get('email')!='steven.r.batchelor@gmail.com':raise SystemExit('Required Claude account not active')
with (p/'claude-graph.out').open('w') as out:
 r=subprocess.run(['/home/steven/.local/bin/claude','-p',(p/'GRAPH-TASK.txt').read_text(),'--permission-mode','dontAsk','--allowedTools','Read,Grep,Glob,Write,Edit','--tools','Read,Grep,Glob,Write,Edit','--max-turns','8','--output-format','json'],stdout=out,stderr=subprocess.STDOUT,timeout=900,cwd=str(p))
(p/'claude-graph.rc').write_text(str(r.returncode)+'\n')
raise SystemExit(r.returncode)

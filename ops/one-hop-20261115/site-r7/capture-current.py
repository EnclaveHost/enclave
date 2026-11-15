"""Read-only: each edge's live Caddy config, Caddyfile and active site tree. The captures hold edge configuration and
stay in this untracked work directory (mode 0600); nothing of them is printed."""
from pathlib import Path
import json,subprocess,shlex,os,sys
p=Path(__file__).resolve().parent
code=(p/'capture-edge-current.py').read_text();expected=json.loads((p/'base-files.json').read_text())
for host in sys.argv[1:] or ['us-west','ca-east','ap-southeast','eu-central']:
 r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',host,'python3 -c '+shlex.quote(code)],capture_output=True,text=True,timeout=90)
 assert r.returncode==0,(host,r.stderr[-400:])
 j=json.loads(r.stdout);assert j['files']==expected,host+' base drift'
 f=p/(host+'.current.json');fd=os.open(f,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
 with os.fdopen(fd,'w') as o:o.write(json.dumps(j,indent=2)+'\n')
 print(host,'files',len(j['files']),'matched base; active root x2:',j['activeRoot'].split('/')[3][:14],'caddyfile roots',j['caddyfile'].count(j['activeRoot']),flush=True)

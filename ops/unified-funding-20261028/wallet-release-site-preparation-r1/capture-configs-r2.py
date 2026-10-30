from pathlib import Path
import subprocess,json,shlex
p=Path(__file__).resolve().parent;code=(p/'capture-config-r2.py').read_text()
for h in ['us-west','ca-east','ap-southeast','eu-central']:
 f=p/(h+'.config-r2.json');assert not f.exists()
 r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',h,'python3 -c '+shlex.quote(code)],capture_output=True,text=True,timeout=30)
 (p/(h+'.config-r2-stderr.txt')).write_text(r.stderr)
 assert r.returncode==0,(h,'capture failed')
 x=json.loads(r.stdout);f.write_text(json.dumps(x,indent=2)+'\n');print(json.dumps({'host':h,'roots':x['roots']}),flush=True)

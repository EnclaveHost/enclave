from pathlib import Path
import json,subprocess,shlex,os
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{1})
code=(p/'capture-edge-current.py').read_text();expected=json.loads((p/'base-files.json').read_text())
with(p/'capture.attempt').open('x')as f:f.write('read-only current exact site roots and content')
for host in ['us-west','ca-east','ap-southeast','eu-central']:
 r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',host,'python3 -c '+shlex.quote(code)],capture_output=True,text=True,timeout=45)
 (p/(host+'.capture.stderr')).write_text(r.stderr);assert r.returncode==0,host
 j=json.loads(r.stdout);assert j['files']==expected,host+' base drift'
 (p/(host+'.current.json')).write_text(json.dumps(j,indent=2)+'\n');print(host+' current1410 matched',flush=True)

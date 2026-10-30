from pathlib import Path
import subprocess,json,shlex,hashlib
p=Path(__file__).resolve().parent
code=(p/'capture-edge.py').read_text()
expected=json.loads((p.parent/'selfhost-topup-production-r1/release.json').read_text())['files']
for host in ['us-west','ca-east','ap-southeast','eu-central']:
 out=p/(host+'.current.json')
 assert not out.exists(),'do not overwrite a prior observation'
 r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',host,'python3 -c '+shlex.quote(code)],capture_output=True,text=True,timeout=45)
 (p/(host+'.capture-stderr.txt')).write_text(r.stderr)
 if r.returncode:raise SystemExit(host+': read failed, no retry')
 d=json.loads(r.stdout);out.write_text(json.dumps(d,indent=2)+'\n')
 assert d['files']==expected,host+': installed bytes changed; refresh source reconstruction before deployment'
 print(json.dumps({'host':host,'files':len(d['files']),'activeRoot':d['activeRoot'],'matchesPreviousRelease':True}),flush=True)

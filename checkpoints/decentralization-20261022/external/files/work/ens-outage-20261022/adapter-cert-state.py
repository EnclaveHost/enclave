from pathlib import Path
import subprocess,json,datetime
remote=r'''sudo python3 - <<'REMOTE'
import json,time,re
from pathlib import Path
x=json.loads(Path('/var/lib/enclave-relay/certs.json').read_text());name='7ae476a3.app.enclave.host'
o={'orders':[],'certificates':[],'failure':None}
for k,v in x.get('orders',{}).items():
 if k.startswith(name+'|'):o['orders'].append({a:v.get(a) for a in ['ca','at','txtName']})
for k,v in x.get('certs',{}).items():
 if v.get('name')==name:o['certificates'].append({a:v.get(a) for a in ['name','ca','issuedAt','notAfter','spkiHash']})
f=x.get('failures',{}).get(name)
if f:o['failure']={'at':f.get('at'),'n':f.get('n'),'error':re.sub(r'(?i)(token|signature|authorization)[=: ]+[^ ,;]+',r'\1=[redacted]',str(f.get('error','')))[:500]}
print(json.dumps(o))
REMOTE'''
cmd=['ssh','-p32423','-o','StrictHostKeyChecking=yes','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','UserKnownHostsFile=work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1',remote]
r=subprocess.run(cmd,capture_output=True,text=True,timeout=40);out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exit':r.returncode,'state':json.loads(r.stdout) if r.stdout.strip().startswith('{') else None,'error':r.stderr[:300]};Path(__file__).with_name('adapter-cert-state.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2));raise SystemExit(r.returncode)

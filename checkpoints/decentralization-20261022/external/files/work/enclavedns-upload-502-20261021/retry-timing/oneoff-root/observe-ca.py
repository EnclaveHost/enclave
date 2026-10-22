import subprocess,json,datetime,pathlib
code=r'''sudo python3 - <<'REMOTE'
import json,time,subprocess
name='ef514ed3.app.enclave.host'
v=json.load(open('/var/lib/private/enclave-relay/certs.json'))
o={'orders':[{'name':r.get('name'),'ca':r.get('ca'),'ageSec':round(time.time()-r.get('at',0)/1000),'keyPrefix':k.split('|')[-1][:16]} for k,r in v.get('orders',{}).items() if k.startswith(name+'|')], 'certs':[{'keyPrefix':k.split('|')[-1][:16],'notAfter':r.get('notAfter')} for k,r in v.get('certs',{}).items() if k.startswith(name+'|')]}
r=subprocess.run(['journalctl','-u','enclave-api-relay','--since','2026-10-21 19:38:00 UTC','--no-pager','-o','short-iso'],capture_output=True,text=True,timeout=20)
o['logs']=[s[:1500] for s in r.stdout.splitlines() if '[certs]' in s][-12:]
print(json.dumps(o))
REMOTE'''
r=subprocess.run(['ssh','-p','32423','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','UserKnownHostsFile=work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1',code],capture_output=True,text=True,timeout=40)
o={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exit':r.returncode,'data':json.loads(r.stdout) if r.returncode==0 else {'error':'probe failed'}}
p=pathlib.Path(__file__).with_name('observe-ca.json');p.write_text(json.dumps(o,indent=2)+'\n');print(json.dumps(o))

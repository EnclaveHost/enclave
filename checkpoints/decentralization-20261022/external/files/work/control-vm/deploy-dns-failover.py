from pathlib import Path
import subprocess,json,hashlib,time,datetime
bundle=Path('work/dns-failover-bundle/dns.mjs');sha=hashlib.sha256(bundle.read_bytes()).hexdigest();assert sha=='3de0fdc04fd8a8c7ecdeacfb73f7b28d357c3f9ecf0464f799e05626a38b494a'
reports=[]
for region,ip in [('us-west','134.199.235.187'),('eu-central','134.209.248.172'),('ap-southeast','165.245.191.129'),('ca-east','146.190.246.39')]:
 subprocess.run(['scp','-q',str(bundle),region+':/tmp/enclave-dns-failover.mjs'],check=True)
 script='''from pathlib import Path
import hashlib,subprocess
p=Path('/etc/systemd/system/enclave-route-dns.service.d/90-dns-front.conf');s=p.read_text();old='/opt/enclave-route-dns/ns-set-8d8fddc/dns.mjs';assert old in s
b=Path('/tmp/enclave-dns-failover.mjs');assert hashlib.sha256(b.read_bytes()).hexdigest()==SHA
out=Path('/opt/enclave-route-dns/failover-3de0fdc');out.mkdir(exist_ok=True);(out/'dns.mjs').write_bytes(b.read_bytes())
backup=p.with_name('rollback-before-failover.txt');assert not backup.exists();backup.write_text(s);p.write_text(s.replace(old,str(out/'dns.mjs')))
subprocess.run(['systemctl','daemon-reload'],check=True);subprocess.run(['systemctl','restart','enclave-route-dns'],check=True)
'''
 subprocess.run(['ssh',region,'python3','-'],input='SHA='+repr(sha)+'\n'+script,text=True,check=True)
 try:
  for attempt in range(8):
   time.sleep(3);values=[]
   for label in ['7ae476a3','d9798e4c']:
    r=subprocess.check_output(['dig','+short','+time=2','+tries=1','@'+ip,label+'.app.enclave.host','A'],text=True)
    values.append([line for line in r.splitlines() if line in ['134.209.248.172','146.190.246.39']])
   if all(values):break
  else:raise RuntimeError('routes not available after DNS restart')
 except BaseException:
  subprocess.run(['ssh',region,'cp /etc/systemd/system/enclave-route-dns.service.d/rollback-before-failover.txt /etc/systemd/system/enclave-route-dns.service.d/90-dns-front.conf\nsystemctl daemon-reload\nsystemctl restart enclave-route-dns'],check=True);raise
 reports.append({'region':region,'adapterAddresses':values[0],'ipnsPublisherAddresses':values[1]});print(region+': DNS routes verified',flush=True)
 Path('outputs/dns-failover-rollout.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sha256':sha,'providers':reports},indent=2)+'\n')

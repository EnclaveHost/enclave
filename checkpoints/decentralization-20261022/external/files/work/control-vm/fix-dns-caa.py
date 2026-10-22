from pathlib import Path
import subprocess,hashlib,json,time,os
bundle=Path('work/dns-caa-bundle/dns.mjs');sha=hashlib.sha256(bundle.read_bytes()).hexdigest()
report=json.loads(Path('outputs/dns-caa-verification.json').read_text()) if os.environ.get('DNS_FIX_HOSTS') else []
for host,ip in [('us-west','134.199.235.187'),('eu-central','134.209.248.172'),('ap-southeast','165.245.191.129'),('ca-east','146.190.246.39')]:
 if os.environ.get('DNS_FIX_HOSTS') and host not in os.environ['DNS_FIX_HOSTS'].split(','):continue
 subprocess.run(['scp','-q',str(bundle),host+':/tmp/enclave-dns-caa.mjs'],check=True)
 remote='SHA='+repr(sha)+'\n'+'''from pathlib import Path
import subprocess,hashlib
src=Path('/tmp/enclave-dns-caa.mjs');assert hashlib.sha256(src.read_bytes()).hexdigest()==SHA
root=Path('/opt/enclave-route-dns/caa-'+SHA[:12]);root.mkdir(exist_ok=True);dst=root/'dns.mjs';dst.write_bytes(src.read_bytes());dst.chmod(0o644)
drop=Path('/etc/systemd/system/enclave-route-dns.service.d/99-caa.conf');assert not drop.exists()
drop.write_text('[Service]\\nExecStart=\\nExecStart=/usr/local/bin/node '+str(dst)+'\\n')
subprocess.run(['systemctl','daemon-reload'],check=True)
try:
 subprocess.run(['systemctl','restart','enclave-route-dns'],check=True)
 subprocess.run(['systemctl','is-active','--quiet','enclave-route-dns'],check=True)
except:
 drop.unlink();subprocess.run(['systemctl','daemon-reload']);subprocess.run(['systemctl','restart','enclave-route-dns']);raise
print('installed '+SHA)
'''
 r=subprocess.run(['ssh',host,'python3','-'],input=remote,text=True,capture_output=True);assert r.returncode==0,r.stderr[-1000:]
 checks=[]
 try:
  for tcp in [False,True]:
   for name,typ,expected in [('9eb4e600.app.enclave.host','CAA','NOERROR'),('ffffffff.app.enclave.host','CAA','NOERROR'),('ffffffff.app.enclave.host','A','SERVFAIL'),('7ae476a3.app.enclave.host','A','NOERROR'),('app.enclave.host','NS','NOERROR')]:
    args=['dig','@'+ip,name,typ,'+time=3','+tries=1','+noall','+comments','+answer']+(['+tcp'] if tcp else [])
    for attempt in range(15):
     q=subprocess.run(args,text=True,capture_output=True)
     ok=q.returncode==0 and 'status: '+expected+',' in q.stdout and (typ!='A' or expected!='NOERROR' or '\tA\t' in q.stdout)
     if ok:break
     time.sleep(2)
    assert ok,(host,name,typ,q.stdout,q.stderr)
    checks.append({'name':name,'type':typ,'tcp':tcp,'rcode':expected})
 except:
  subprocess.run(['ssh',host,"rm /etc/systemd/system/enclave-route-dns.service.d/99-caa.conf && systemctl daemon-reload && systemctl restart enclave-route-dns"],check=True);raise
 report.append({'host':host,'ip':ip,'sha256':sha,'checks':checks})
 print(host+': CAA parent lookup, closed address lookup, existing app and NS checks passed',flush=True)
 Path('outputs/dns-caa-verification.json').write_text(json.dumps(report,indent=2)+'\n')

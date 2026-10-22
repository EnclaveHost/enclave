import subprocess,json,pathlib,datetime
remote=r'''sudo python3 - <<'REMOTE'
import subprocess,json,re,urllib.request
r=subprocess.run(['journalctl','-u','enclave-api-relay','--since','35 minutes ago','-n','12000','--no-pager','-o','cat'],capture_output=True,text=True,timeout=20)
lines=[]
for s in r.stdout.splitlines():
 if '59f1273d' in s:
  s=re.sub(r'(?i)(token|signature|authorization)[=: ]+[^ ,;]+',r'\1=[redacted]',s)
  lines.append(s[:1100])
print(json.dumps({'enclaveDnsCertificateLogs':lines[-30:]}))
REMOTE'''
cmd=['ssh','-p32423','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','UserKnownHostsFile=work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1',remote]
r=subprocess.run(cmd,capture_output=True,text=True,timeout=45)
o={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exit':r.returncode,'out':r.stdout,'err':r.stderr[:1000]};pathlib.Path(__file__).with_name('root-cert-diagnostics.json').write_text(json.dumps(o,indent=2)+'\n');print(json.dumps(o))

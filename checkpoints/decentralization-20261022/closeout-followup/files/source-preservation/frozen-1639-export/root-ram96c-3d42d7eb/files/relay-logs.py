import subprocess,json,pathlib,datetime
remote=r"""sudo python3 - <<'REMOTE'
import subprocess,json,re
r=subprocess.run(['journalctl','-u','enclave-api-relay','--since','2026-10-23 15:30:00 UTC','-n','8000','--no-pager','-o','short-iso'],capture_output=True,text=True,timeout=15)
lines=[]
for l in r.stdout.splitlines():
 if any(x in l.lower() for x in ['7ae476a3','59f1273d','acme','certificate']):
  l=re.sub(r'(?i)(token|signature|authorization|secret|password)[=: ]+[^ ,;]+',r'\1=[redacted]',l);lines.append(l[:700])
print(json.dumps({'exit':r.returncode,'logs':lines[-60:]}))
REMOTE"""
cmd=['ssh','-J','minipc','-o','HostKeyAlias=[127.0.0.1]:32423','-o','BatchMode=yes','-o','ConnectTimeout=6','-o','UserKnownHostsFile=work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@172.17.28.159',remote]
r=subprocess.run(cmd,capture_output=True,text=True,timeout=30)
o={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exit':r.returncode,'out':r.stdout,'error':r.stderr[:300]}
f=pathlib.Path('work/nucbox-ram96-20261023')/('relay-recovery-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.json');f.write_text(json.dumps(o,indent=2)+'\n');print(json.dumps(o));print('Saved',f)

from pathlib import Path
import subprocess,json,hashlib,shlex
p=Path(__file__).resolve().parent
code="import subprocess,json,pathlib,urllib.parse,datetime\ns=subprocess.check_output(['systemctl','show','enclave-api-relay.service','-p','MainPID','-p','InvocationID'],text=True);v=dict(x.split('=',1)for x in s.splitlines()if '=' in x);pid=int(v['MainPID']);assert pid>0\nr={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'identity':v,'origins':{}}\nfor x in pathlib.Path('/proc/'+str(pid)+'/environ').read_bytes().split(b'\\0'):\n k,sep,value=x.partition(b'=')\n if k not in {b'BASE_RPC',b'SESSIONS_RPC',b'SESSIONS_PUBLIC_RPC'}:continue\n r['origins'][k.decode()]=[]\n for raw in value.decode().split(','):\n  u=urllib.parse.urlsplit(raw.strip());r['origins'][k.decode()].append({'scheme':u.scheme,'host':u.hostname,'hasCredentialOrNonrootPath':bool(u.username or u.password or u.query or u.path not in ['', '/'])})\nassert subprocess.check_output(['systemctl','show','enclave-api-relay.service','-p','MainPID','-p','InvocationID'],text=True)==s\nprint(json.dumps(r))\n"
ssh=['ssh','-J','minipc','-o','BatchMode=yes','-o','HostKeyAlias=[127.0.0.1]:32423','-o','UserKnownHostsFile=/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/known_hosts','-o','ConnectTimeout=10','-i','/home/steven/.ssh/minipc','controladmin@172.17.28.159']
with (p/'attempt').open('x') as f:f.write('bounded public-source read only\n')
r=subprocess.run(ssh+['sudo -n python3 -c '+shlex.quote(code)],capture_output=True,text=True,timeout=45)
(p/'stderr.txt').write_text(r.stderr)
if r.returncode:raise SystemExit(r.returncode)
j=json.loads(r.stdout)
(p/'result.json').write_text(json.dumps(j,indent=2)+'\n')
print(json.dumps(j))

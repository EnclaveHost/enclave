from pathlib import Path
import subprocess,json,hashlib,shlex
p=Path(__file__).resolve().parent
code="import subprocess,json,pathlib,urllib.parse,datetime\ns=subprocess.check_output(['systemctl','show','enclave-rpc-gateway.service','-p','MainPID','-p','InvocationID'],text=True);v=dict(x.split('=',1)for x in s.splitlines()if '=' in x);pid=int(v['MainPID']);assert pid>0\nargs=pathlib.Path('/proc/'+str(pid)+'/cmdline').read_bytes().split(b'\\0');assert args[1].decode()=='/opt/enclave-rpc/gateway.mjs'\np=pathlib.Path(args[2].decode());raw=p.read_bytes();assert len(raw)<65536\ncfg=json.loads(raw);r={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'identity':v,'origins':{}}\nfor chain,urls in cfg.get('upstreams',{}).items():\n r['origins'][chain]=[{'scheme':urllib.parse.urlsplit(x).scheme,'host':urllib.parse.urlsplit(x).hostname} for x in urls]\nassert subprocess.check_output(['systemctl','show','enclave-rpc-gateway.service','-p','MainPID','-p','InvocationID'],text=True)==s\nprint(json.dumps(r))\n"
ssh=['ssh','-J','minipc','-o','BatchMode=yes','-o','HostKeyAlias=[127.0.0.1]:32423','-o','UserKnownHostsFile=/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/known_hosts','-o','ConnectTimeout=10','-i','/home/steven/.ssh/minipc','controladmin@172.17.28.159']
with (p/'attempt').open('x') as f:f.write('bounded public-source read only\n')
r=subprocess.run(ssh+['sudo -n python3 -c '+shlex.quote(code)],capture_output=True,text=True,timeout=45)
(p/'stderr.txt').write_text(r.stderr)
if r.returncode:raise SystemExit(r.returncode)
j=json.loads(r.stdout)
(p/'result.json').write_text(json.dumps(j,indent=2)+'\n')
print(json.dumps(j))

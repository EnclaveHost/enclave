from pathlib import Path
import subprocess,json,hashlib,shlex
p=Path(__file__).resolve().parent
code='import subprocess,json,pathlib,urllib.parse,re,datetime\ns=subprocess.check_output([\'systemctl\',\'show\',\'enclave-rpc-gateway.service\',\'-p\',\'MainPID\',\'-p\',\'InvocationID\'],text=True);v=dict(x.split(\'=\',1)for x in s.splitlines()if \'=\' in x);pid=int(v[\'MainPID\']);assert pid>0\nsrc=pathlib.Path(\'/opt/enclave-rpc/gateway.mjs\').read_text();assert len(src)<262144\norigins=sorted(set(urllib.parse.urlsplit(x).hostname for x in re.findall(r\'https?://[^\\s\\"\\\']+\',src)))\nlines=[line for line in src.splitlines() if any(x in line for x in [\'credential\',\'Credential\',\'CREDENTIAL\',\'UPSTREAM\',\'upstream\',\'readFile\',\'rpc/base\'])]\ndef safe(line):\n return re.sub(r\'https?://[^\\s\\"\\\']+\',lambda m: urllib.parse.urlsplit(m.group()).scheme+\'://\'+str(urllib.parse.urlsplit(m.group()).hostname)+\'/[redacted]\',line)\nr={\'at\':datetime.datetime.now(datetime.timezone.utc).isoformat(),\'identity\':v,\'origins\':origins,\'sourceStructure\':[safe(x) for x in lines]}\nassert subprocess.check_output([\'systemctl\',\'show\',\'enclave-rpc-gateway.service\',\'-p\',\'MainPID\',\'-p\',\'InvocationID\'],text=True)==s\nprint(json.dumps(r))\n'
ssh=['ssh','-J','minipc','-o','BatchMode=yes','-o','HostKeyAlias=[127.0.0.1]:32423','-o','UserKnownHostsFile=/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/known_hosts','-o','ConnectTimeout=10','-i','/home/steven/.ssh/minipc','controladmin@172.17.28.159']
with (p/'attempt').open('x') as f:f.write('bounded public-source read only\n')
r=subprocess.run(ssh+['sudo -n python3 -c '+shlex.quote(code)],capture_output=True,text=True,timeout=45)
(p/'stderr.txt').write_text(r.stderr)
if r.returncode:raise SystemExit(r.returncode)
j=json.loads(r.stdout)
(p/'result.json').write_text(json.dumps(j,indent=2)+'\n')
print(json.dumps(j))

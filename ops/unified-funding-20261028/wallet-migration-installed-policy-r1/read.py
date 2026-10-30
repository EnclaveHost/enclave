from pathlib import Path
import subprocess,json,hashlib,shlex
p=Path(__file__).resolve().parent
code="""import subprocess,json,pathlib,hashlib,datetime
s=subprocess.check_output(['systemctl','show','enclave-api-relay.service','-p','MainPID','-p','InvocationID','-p','WorkingDirectory'],text=True)
v=dict(x.split('=',1) for x in s.splitlines() if '=' in x);pid=int(v['MainPID']);assert pid>0
root=pathlib.Path('/proc')/str(pid)/'cwd';assert root.resolve()==pathlib.Path('/opt/nan-relay')
r={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'service':v,'files':{},'readOnly':True}
for n in ['sessions.mjs','secrets.js','secrets-release.mjs','shield-secrets.mjs','session-api-auth.mjs']:
 f=root/n
 if not f.exists():r['files'][n]={'absent':True};continue
 assert f.stat().st_size<1048576
 b=f.read_bytes();r['files'][n]={'sha256':hashlib.sha256(b).hexdigest(),'source':b.decode()}
assert subprocess.check_output(['systemctl','show','enclave-api-relay.service','-p','MainPID','-p','InvocationID','-p','WorkingDirectory'],text=True)==s
print(json.dumps(r))
"""
ssh=['ssh','-J','minipc','-o','BatchMode=yes','-o','HostKeyAlias=[127.0.0.1]:32423','-o','UserKnownHostsFile=/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/known_hosts','-o','ConnectTimeout=10','-i','/home/steven/.ssh/minipc','controladmin@172.17.28.159']
with (p/'attempt').open('x') as f:f.write('bounded public-source read only\n')
r=subprocess.run(ssh+['sudo -n python3 -c '+shlex.quote(code)],capture_output=True,text=True,timeout=45)
(p/'stderr.txt').write_text(r.stderr)
if r.returncode:raise SystemExit(r.returncode)
j=json.loads(r.stdout)
for n,v in j['files'].items():
 if 'source' in v:
  (p/n).write_text(v.pop('source'))
(p/'result.json').write_text(json.dumps(j,indent=2)+'\n')
print(json.dumps(j))

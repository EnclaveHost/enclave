from pathlib import Path
import subprocess,json,datetime,hashlib
ssh=['ssh','-p32423','-o','UserKnownHostsFile=work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1']
def remote(host,script):
 cmd=ssh+['sudo python3 -'] if host=='control' else ['ssh',host,'python3','-']
 r=subprocess.run(cmd,input=script,capture_output=True,text=True);assert r.returncode==0,host+': '+r.stderr[-1500:];return r.stdout
started=datetime.datetime.now(datetime.timezone.utc).isoformat();targetStarted=False
remote('control',"from pathlib import Path\nimport subprocess\nassert not Path('/etc/enclave-control/ALLOW_CONTROL_START').exists()\nassert not Path('/var/lib/private/enclave-relay').exists()\nsubprocess.run(['systemctl','is-active','--quiet','enclave-control-tls'],check=True)\n")
subprocess.run(['curl','-fsS','--max-time','15','--resolve','get.enclave.host:443:134.199.235.187','https://get.enclave.host/install.sh','-o','/dev/null'],check=True)
print('Preconditions passed; fencing source API',flush=True)
try:
 remote('nan',"""from pathlib import Path
import subprocess,hashlib
p=Path('/etc/caddy/Caddyfile');assert hashlib.sha256(p.read_bytes()).hexdigest()==Path('/var/lib/indexd-migration/control-proxy-source.sha256').read_text()
for s in ['enclave-policy-migration-bridge','enclave-provider-migration-mirror','enclave-api-relay']:
 d=Path('/etc/systemd/system')/(s+'.service.d');d.mkdir(exist_ok=True);f=d/'99-control-migration-fence.conf';assert not f.exists();f.write_text('[Unit]\\nConditionPathExists=/etc/nan-relay/ALLOW_NAN_CONTROL_WRITER\\n')
assert not Path('/etc/nan-relay/ALLOW_NAN_CONTROL_WRITER').exists()
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','stop','enclave-policy-migration-bridge','enclave-provider-migration-mirror','enclave-api-relay'],check=True)
for s in ['enclave-policy-migration-bridge','enclave-provider-migration-mirror','enclave-api-relay']:assert subprocess.run(['systemctl','is-active','--quiet',s]).returncode!=0
out=Path('/var/lib/indexd-migration/control-state-final.tar.gz');assert not out.exists()
with out.open('wb') as f:subprocess.run(['tar','--exclude=enclave-relay/predict','-C','/var/lib/private','-czf','-','enclave-relay'],stdout=f,check=True)
out.chmod(0o600)
Path('/var/lib/indexd-migration/control-state-final.sha256').write_text(hashlib.file_digest(out.open('rb'),'sha256').hexdigest())
""")
 print('Source fenced and snapshot complete; transferring private state',flush=True)
 with open('work/control-vm/api-state-transfer.log','wb') as log:
  a=subprocess.Popen(['ssh','nan','cat','/var/lib/indexd-migration/control-state-final.tar.gz'],stdout=subprocess.PIPE,stderr=log)
  b=subprocess.Popen(ssh+['sudo sh -c "umask 077; cat > /var/lib/enclave-migration/control-state-final.tar.gz"'],stdin=a.stdout,stderr=log);a.stdout.close();assert b.wait()==0 and a.wait()==0
 digest=remote('nan',"from pathlib import Path\nprint(Path('/var/lib/indexd-migration/control-state-final.sha256').read_text())\n").strip();assert len(digest)==64
 remote('control',"""from pathlib import Path
import hashlib,subprocess,os
p=Path('/var/lib/enclave-migration/control-state-final.tar.gz');assert hashlib.file_digest(p.open('rb'),'sha256').hexdigest()==DIGEST
Path('/var/lib/private').mkdir(mode=0o700,exist_ok=True)
subprocess.run(['tar','-C','/var/lib/private','-xzf',str(p),'--no-same-owner'],check=True)
assert not Path('/var/lib/enclave-relay').exists();os.symlink('/var/lib/private/enclave-relay','/var/lib/enclave-relay')
subprocess.run(['systemctl','stop','enclave-dns-shadow'],check=True)
subprocess.run(['systemctl','start','enclave-dns'],check=True)
Path('/etc/enclave-control/ALLOW_CONTROL_START').touch(mode=0o600)
""".replace('DIGEST',repr(digest)))
 targetStarted=True
 remote('control',"""import subprocess,time,urllib.request,json
subprocess.run(['systemctl','start','enclave-api-relay'],check=True)
for i in range(60):
 try:
  x=json.load(urllib.request.urlopen('http://127.0.0.1:8100/health',timeout=3));assert x.get('ok');break
 except Exception:time.sleep(1)
else:raise RuntimeError('Destination API did not pass health check')
""")
 subprocess.run(['curl','-fsS','--max-time','20','--resolve','api.enclave.host:443:134.199.235.187','https://api.enclave.host/health','-o','work/control-vm/api-health-direct-cutover.json'],check=True)
 print('Destination API healthy; activating temporary compatibility proxy',flush=True)
 remote('nan',"""from pathlib import Path
import shutil,subprocess,hashlib
p=Path('/etc/caddy/Caddyfile');assert hashlib.sha256(p.read_bytes()).hexdigest()==Path('/var/lib/indexd-migration/control-proxy-source.sha256').read_text()
b=Path('/var/lib/indexd-migration/Caddyfile.before-control-proxy');assert not b.exists();shutil.copy2(p,b)
shutil.copy2('/var/lib/indexd-migration/Caddyfile.control-proxy',p)
subprocess.run(['systemctl','reload','caddy'],check=True)
subprocess.run(['systemctl','disable','enclave-api-relay','enclave-policy-migration-bridge','enclave-provider-migration-mirror'],check=True,capture_output=True)
""")
 remote('control',"""import subprocess
subprocess.run(['systemctl','enable','--now','enclave-api-relay','enclave-dns','enclave-policy-migration-bridge','enclave-provider-migration-mirror','enclave-control-tls'],check=True,capture_output=True)
""")
 report={'startedAt':started,'completedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceAPIFencedAndStopped':True,'destinationAPIActive':True,'privateStateArchiveSHA256':digest,'temporaryNanCompatibilityProxy':True,'publicDNSChanged':False}
 Path('outputs/control-api-cutover.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
except:
 if not targetStarted:
  remote('nan',"""from pathlib import Path
import subprocess
for s in ['enclave-policy-migration-bridge','enclave-provider-migration-mirror','enclave-api-relay']:(Path('/etc/systemd/system')/(s+'.service.d/99-control-migration-fence.conf')).unlink(missing_ok=True)
subprocess.run(['systemctl','daemon-reload']);subprocess.run(['systemctl','start','enclave-api-relay','enclave-policy-migration-bridge','enclave-provider-migration-mirror'])
""")
 else:print('Target may have written state; source remains fenced. Repair destination or stop it and copy latest state back before any rollback.',flush=True)
 raise

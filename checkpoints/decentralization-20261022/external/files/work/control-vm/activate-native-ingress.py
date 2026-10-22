import subprocess,sys
script='''from pathlib import Path
import json,hashlib,shutil,subprocess,time
p=Path('/etc/enclave-bootstrap-tls');config=Path('/etc/enclave-network/provider-pinned-8b37c37.json');assert hashlib.sha256(config.read_bytes()).hexdigest()==(p/'provider.native-before.sha256').read_text()
backup=p/'provider.before-native.json';assert not backup.exists();shutil.copy2(config,backup);backup.chmod(0o600)
shutil.copy2(p/'Caddyfile',p/'Caddyfile.before-native')
unit=Path('/etc/systemd/system/enclave-bootstrap-tls.service');shutil.copy2(unit,p/'service.before-native')
new=(p/'Caddyfile.native-prepared').read_text().replace('auto_https disable_redirects','auto_https disable_redirects ignore_loaded_certs');(p/'Caddyfile.native-prepared').write_text(new)
r=subprocess.run(['/usr/local/lib/enclave-caddy/caddy','validate','--config',str(p/'Caddyfile.native-prepared'),'--adapter','caddyfile'],capture_output=True,text=True);assert r.returncode==0,r.stderr[-1000:]
d=Path('/etc/systemd/system/enclave-network-provider.service.d');d.mkdir(exist_ok=True);drop=d/'zzz-native-ingress.conf';assert not drop.exists();drop.write_text('[Service]\\nExecStart=\\nExecStart=/usr/local/bin/node /opt/enclave-network/native-recovery-464cad3/provider.mjs /etc/enclave-network/provider-pinned-8b37c37.json\\n')
shutil.copy2(p/'provider.native-prepared.json',config);shutil.copy2(p/'Caddyfile.native-prepared',p/'Caddyfile');unit.write_text(unit.read_text().replace('/usr/bin/caddy','/usr/local/lib/enclave-caddy/caddy'))
try:
 subprocess.run(['systemctl','daemon-reload'],check=True);subprocess.run(['systemctl','restart','enclave-network-provider'],check=True);subprocess.run(['systemctl','restart','enclave-bootstrap-tls'],check=True);time.sleep(2)
 subprocess.run(['systemctl','is-active','--quiet','enclave-network-provider','enclave-bootstrap-tls'],check=True)
 assert '/opt/enclave-network/native-recovery-464cad3/provider.mjs' in subprocess.check_output(['systemctl','show','enclave-network-provider','-p','ExecStart'],text=True)
except:
 shutil.copy2(backup,config);shutil.copy2(p/'Caddyfile.before-native',p/'Caddyfile');shutil.copy2(p/'service.before-native',unit);drop.unlink();subprocess.run(['systemctl','daemon-reload']);subprocess.run(['systemctl','restart','enclave-network-provider']);subprocess.run(['systemctl','restart','enclave-bootstrap-tls']);raise
print(json.dumps({'nativeIngressActive':True,'managedStaticCertificateIssuanceStarted':True}))
'''
h=sys.argv[1];r=subprocess.run(['ssh',h,'python3','-'],input=script,text=True,capture_output=True);assert r.returncode==0,r.stderr[-1800:];print(h+': '+r.stdout.strip())

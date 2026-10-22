from pathlib import Path
import subprocess
ssh=['ssh','-p32423','-o','UserKnownHostsFile=work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1']
script='''from pathlib import Path
import subprocess,json,shutil,os
state=Path('/var/lib/private/enclave-control-tls');state.mkdir(mode=0o700,parents=True,exist_ok=True);native=state/'native';native.mkdir(mode=0o700,exist_ok=True)
for name in ['services.pem','services.key']:
 shutil.copyfile(Path('/var/lib/enclave-native-ca')/name,native/name);(native/name).chmod(0o600)
p=Path('/etc/enclave-control-tls/caddy.json');backup=p.with_name('caddy.before-managed.json');assert not backup.exists();shutil.copy2(p,backup)
x=json.loads(p.read_text());x['admin']={'listen':'unix//run/enclave-control-tls/admin.sock'}
x['apps']['http']['servers']['control']['automatic_https']={'disable_redirects':True,'skip':['api.enclavehost.eth','mcp.enclavehost.eth','*.app.enclave.host','62.238.4.214']}
x['apps']['tls']['certificates']['load_files']=[{'certificate':'/var/lib/enclave-control-tls/native/services.pem','key':'/var/lib/enclave-control-tls/native/services.key'}]
x['apps']['tls']['automation']={'policies':[{'subjects':['api.enclave.host','mcp.enclave.host','get.enclave.host'],'issuers':[{'module':'acme','ca':'https://acme-v02.api.letsencrypt.org/directory','challenges':{'tls-alpn':{'disabled':True}}}]}]}
# Validate provisioned modules using physical paths before systemd creates its state symlink.
check=json.loads(json.dumps(x));c=check['apps']['tls']['certificates']['load_files'][0];c['certificate']=str(native/'services.pem');c['key']=str(native/'services.key');temp=p.with_name('caddy.validate.json');temp.write_text(json.dumps(check));r=subprocess.run(['caddy','validate','--config',str(temp)],capture_output=True,text=True);assert r.returncode==0,r.stderr[-1000:]
p.write_text(json.dumps(x,indent=2)+'\\n')
u=Path('/etc/systemd/system/enclave-control-tls.service');ub=u.with_suffix('.before-managed');assert not ub.exists();shutil.copy2(u,ub)
s=u.read_text();s='\\n'.join(l for l in s.splitlines() if not l.startswith('LoadCredential='))+'\\n';s=s.replace('[Service]','[Service]\\nStateDirectory=enclave-control-tls\\nStateDirectoryMode=0700\\nRuntimeDirectory=enclave-control-tls\\nRuntimeDirectoryMode=0700\\nEnvironment=XDG_DATA_HOME=/var/lib/enclave-control-tls/data\\nEnvironment=XDG_CONFIG_HOME=/var/lib/enclave-control-tls/config\\nExecReload=/usr/bin/caddy reload --config /etc/enclave-control-tls/caddy.json --address unix//run/enclave-control-tls/admin.sock');u.write_text(s)
subprocess.run(['systemctl','daemon-reload'],check=True);subprocess.run(['systemctl','restart','enclave-control-tls'],check=True)
print('Managed certificate configuration activated; issuance verification pending')
'''
r=subprocess.run(ssh+['sudo python3 -'],input=script,text=True,capture_output=True);assert r.returncode==0,r.stderr[-1500:];print(r.stdout)

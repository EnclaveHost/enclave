from pathlib import Path
import subprocess,json
ssh=['ssh','-p32423','-o','UserKnownHostsFile=work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1']
# Copy certificates and native CA directly between authenticated SSH channels.
paths=['var/lib/enclave-native-ca']
for name in ['api.enclave.host','mcp.enclave.host','get.enclave.host']:
 for ext in ['crt','key']:paths.append('var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/'+name+'/'+name+'.'+ext)
with open('work/control-vm/control-cert-transfer.log','wb') as log:
 a=subprocess.Popen(['ssh','nan','tar','-C','/','-czf','-',*paths],stdout=subprocess.PIPE,stderr=log)
 b=subprocess.Popen(ssh+['sudo tar -C /var/lib/enclave-migration/staged -xzf - --no-same-owner'],stdin=a.stdout,stderr=log);a.stdout.close();assert b.wait()==0 and a.wait()==0
script='''from pathlib import Path
import shutil,subprocess,json,os
stage=Path('/var/lib/enclave-migration/staged')
for name in ['nan-relay','enclave-dns']:
 dst=Path('/etc')/name
 assert not dst.exists();shutil.copytree(stage/'etc'/name,dst)
for service in ['enclave-api-relay','enclave-dns','enclave-policy-migration-bridge','enclave-provider-migration-mirror']:
 src=stage/'etc/systemd/system'/(service+'.service');dst=Path('/etc/systemd/system')/src.name;assert not dst.exists();shutil.copy2(src,dst)
 sd=src.with_name(src.name+'.d')
 if sd.exists():shutil.copytree(sd,dst.with_name(dst.name+'.d'))
 if service!='enclave-dns':
  dr=dst.with_name(dst.name+'.d');dr.mkdir(exist_ok=True);(dr/'99-control-migration.conf').write_text('[Unit]\\nConditionPathExists=/etc/enclave-control/ALLOW_CONTROL_START\\n')
# No live API service can start until cutover opens the marker.
Path('/etc/enclave-control').mkdir(mode=0o700,exist_ok=True)
assert not Path('/etc/enclave-control/ALLOW_CONTROL_START').exists()
root=Path('/etc/enclave-control-tls');root.mkdir(mode=0o755,exist_ok=True);creds=root/'credentials';creds.mkdir(mode=0o700,exist_ok=True)
certs=[];loads=[]
for n in ['api.enclave.host','mcp.enclave.host','get.enclave.host']:
 for ext in ['crt','key']:
  src=stage/'var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory'/n/(n+'.'+ext);dst=creds/(n+'.'+ext);shutil.copyfile(src,dst);dst.chmod(0o600);loads.append('LoadCredential='+dst.name+':'+str(dst))
 certs.append({'certificate':'/run/credentials/enclave-control-tls.service/'+n+'.crt','key':'/run/credentials/enclave-control-tls.service/'+n+'.key'})
source=stage/'etc/caddy/Caddyfile';r=subprocess.run(['caddy','adapt','--config',str(source),'--adapter','caddyfile'],capture_output=True,text=True,check=True);config=json.loads(r.stdout)
selected=[]
for server in config['apps']['http']['servers'].values():
 for route in server['routes']:
  names=[n for m in route.get('match',[]) for n in m.get('host',[])]
  if any(n in ['api.enclave.host','mcp.enclave.host','get.enclave.host'] for n in names):selected.append(route)
assert len(selected)==3
config={'admin':{'disabled':True},'apps':{'http':{'servers':{'control':{'listen':['127.0.0.1:30443'],'protocols':['h1','h2'],'automatic_https':{'disable':True},'tls_connection_policies':[{}],'routes':selected}}},'tls':{'certificates':{'load_files':certs}}}}
(root/'caddy.json').write_text(json.dumps(config,indent=2)+'\\n')
unit='[Unit]\\nDescription=Enclave control API and download TLS front\\nAfter=network-online.target\\n[Service]\\nDynamicUser=yes\\nExecStart=/usr/bin/caddy run --config /etc/enclave-control-tls/caddy.json\\nRestart=on-failure\\nRestartSec=3\\nNoNewPrivileges=yes\\nProtectSystem=strict\\nProtectHome=yes\\nPrivateTmp=yes\\nMemoryMax=256M\\nTasksMax=128\\n'+ '\\n'.join(loads)+'\\n[Install]\\nWantedBy=multi-user.target\\n'
Path('/etc/systemd/system/enclave-control-tls.service').write_text(unit)
subprocess.run(['systemctl','daemon-reload'],check=True);subprocess.run(['systemctl','start','enclave-control-tls'],check=True)
print(json.dumps({'apiConfigurationInstalledButFenced':True,'controlTLSStarted':True,'productionTrafficChanged':False}))
'''
r=subprocess.run(ssh+['sudo python3 -'],input=script,capture_output=True,text=True);assert r.returncode==0,r.stderr[-2000:];print(r.stdout)

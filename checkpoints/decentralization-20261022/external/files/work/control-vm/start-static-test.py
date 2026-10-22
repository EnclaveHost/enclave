from pathlib import Path
import subprocess
p=Path('/etc/enclave-bootstrap-tls/Caddyfile.site-prepared');s=p.read_text().replace('http_port 28080','http_port 38080').replace('https_port 28443','https_port 38443').replace('auto_https disable_redirects','auto_https off')
test=p.with_name('Caddyfile.site-test');test.write_text(s)
cmd=['systemd-run','--unit=enclave-static-front-test','--property=DynamicUser=yes','--property=MemoryMax=192M','--property=NoNewPrivileges=yes','--property=PrivateTmp=yes','--property=ProtectSystem=strict','--property=ProtectHome=yes']
for n in ['enclave.host','www.enclave.host','ipfs.enclave.host']:
 for e in ['crt','key']:cmd.append('--property=LoadCredential='+n+'.'+e+':/etc/enclave-bootstrap-tls/credentials/'+n+'.'+e)
cmd.extend(['/usr/bin/caddy','run','--config',str(test),'--adapter','caddyfile']);subprocess.run(cmd,check=True,capture_output=True);print('Isolated static front running on loopback 38443; production listeners unchanged.')

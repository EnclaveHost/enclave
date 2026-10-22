from pathlib import Path
import subprocess,json
ips={'us-west':'134.199.235.187','eu-central':'134.209.248.172','ap-southeast':'165.245.191.129','ca-east':'146.190.246.39'}
for host,ip in ips.items():
 peers=[v for h,v in ips.items() if h!=host]
 def proxy(i,indent=8):
  pad=' '*indent
  body=pad+'reverse_proxy http://'+peers[i]+' {\n'+pad+'    header_up Host {http.request.host}\n'+pad+'    header_up X-Enclave-ACME-Hop 1\n'
  if i+1<len(peers):body+=pad+'    @missing status 404\n'+pad+'    handle_response @missing {\n'+proxy(i+1,indent+8)+pad+'    }\n'
  return body+pad+'}\n'
 extra='''
http://enclave.host, http://www.enclave.host, http://ipfs.enclave.host {
    bind 127.0.0.1
    @forwardChallenge {
        path /.well-known/acme-challenge/*
        not header X-Enclave-ACME-Hop 1
        method GET
    }
    handle @forwardChallenge {
'''+proxy(0)+'''    }
    handle /.well-known/acme-challenge/* {
        respond 404
    }
    handle {
        redir https://{host}{uri} permanent
    }
}
'''
 script='''from pathlib import Path
import os,json,subprocess,shutil
p=Path('/etc/enclave-bootstrap-tls');active=p/'Caddyfile';unit=Path('/etc/systemd/system/enclave-bootstrap-tls.service')
assert not (p/'Caddyfile.before-renewal').exists();shutil.copy2(active,p/'Caddyfile.before-renewal');shutil.copy2(unit,p/'service.before-renewal')
s=active.read_text();assert s.count('admin off')==1;s=s.replace('admin off','admin unix//run/enclave-bootstrap-tls/admin.sock')+EXTRA
candidate=p/'Caddyfile.renewal-prepared';candidate.write_text(s)
r=subprocess.run(['caddy','validate','--config',str(candidate),'--adapter','caddyfile'],env=dict(os.environ,CREDENTIALS_DIRECTORY=str(p/'credentials')),capture_output=True,text=True);assert r.returncode==0,r.stderr[-1200:]
u=unit.read_text().replace('[Service]','[Service]\\nRuntimeDirectory=enclave-bootstrap-tls\\nRuntimeDirectoryMode=0700\\nExecReload=/usr/bin/caddy reload --config /etc/enclave-bootstrap-tls/Caddyfile --adapter caddyfile --address unix//run/enclave-bootstrap-tls/admin.sock')
(p/'service.renewal-prepared').write_text(u)
print(json.dumps({'challengeFailoverPrepared':True,'existingCertificatesRetained':True}))
'''
 r=subprocess.run(['ssh',host,'python3','-'],input='EXTRA='+repr(extra)+'\n'+script,text=True,capture_output=True);assert r.returncode==0,r.stderr[-1500:];print(host+': '+r.stdout.strip(),flush=True)

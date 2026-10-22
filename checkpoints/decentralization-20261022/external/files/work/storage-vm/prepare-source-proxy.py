from pathlib import Path
import subprocess,hashlib,json
p=Path('/etc/caddy/Caddyfile');s=p.read_text();old='sia.enclave.host {\n\trequest_body {\n\t\tmax_size 16MB\n\t}\n\treverse_proxy 127.0.0.1:9982\n}'
assert s.count(old)==1,'Source Sia proxy changed'
new='''sia.enclave.host {
    request_body {
        max_size 16MB
    }
    reverse_proxy https://134.199.235.187 https://134.209.248.172 https://165.245.191.129 https://146.190.246.39 {
        header_up Host sia.enclave.host
        lb_policy first
        lb_try_duration 5s
        transport http {
            tls_server_name sia.enclave.host
        }
    }
}'''
base=Path('/var/lib/indexd-migration');base.mkdir(mode=0o700,exist_ok=True)
backup=base/'Caddyfile.before-storage';assert not backup.exists();backup.write_text(s);backup.chmod(0o600)
prepared=base/'Caddyfile.storage-proxy';prepared.write_text(s.replace(old,new));prepared.chmod(0o600)
r=subprocess.run(['caddy','validate','--config',str(prepared),'--adapter','caddyfile'],capture_output=True,text=True)
assert r.returncode==0,'Prepared proxy validation failed'
report={'validated':True,'sourceSHA256':hashlib.sha256(s.encode()).hexdigest(),'preparedSHA256':hashlib.sha256(prepared.read_bytes()).hexdigest(),'changedHost':'sia.enclave.host','tlsValidation':'normal hostname validation; no insecure override'}
(base/'proxy-prepared.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))

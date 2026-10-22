from pathlib import Path
import subprocess,json,sys,os,hashlib
region=sys.argv[1]
assert region in ['us-west','eu-central','ap-southeast','ca-east']
hostname='bootstrap-'+region+'.enclave.host'
base=Path('/etc/enclave-bootstrap-tls');base.mkdir(mode=0o755,exist_ok=True)
config=base/'Caddyfile'
text='''{
    admin off
    http_port 28080
    https_port 28443
    servers {
        protocols h1 h2
    }
    auto_https disable_redirects
}
HOSTNAME {
    bind 127.0.0.1
    reverse_proxy 127.0.0.1:8189
}
'''.replace('HOSTNAME',hostname)
assert not config.exists() or config.read_text()==text,'Bootstrap TLS config differs'
config.write_text(text);config.chmod(0o644)
p=subprocess.run(['caddy','validate','--config',str(config),'--adapter','caddyfile'],capture_output=True)
assert p.returncode==0,'Caddy configuration validation failed'
unit=Path('/etc/systemd/system/enclave-bootstrap-tls.service')
unit_text='''[Unit]
Description=TLS for the public CID-verified Enclave bootstrap replica
After=network-online.target enclave-bootstrap-gateway.service enclave-network-provider.service
Wants=network-online.target
[Service]
Type=notify
DynamicUser=yes
StateDirectory=enclave-bootstrap-tls
Environment=XDG_DATA_HOME=/var/lib/enclave-bootstrap-tls/data
Environment=XDG_CONFIG_HOME=/var/lib/enclave-bootstrap-tls/config
ExecStart=/usr/bin/caddy run --config /etc/enclave-bootstrap-tls/Caddyfile --adapter caddyfile
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
MemoryMax=192M
TasksMax=64
[Install]
WantedBy=multi-user.target
'''
assert not unit.exists() or unit.read_text()==unit_text,'Bootstrap TLS service differs'
unit.write_text(unit_text);unit.chmod(0o644)
active=Path('/etc/enclave-network/provider-pinned-8b37c37.json')
doc=json.loads(active.read_text());routes=doc.setdefault('localRoutes',{})
assert hostname not in routes,'Route already configured; inspect before rerunning'
assert routes.get('sia.enclave.host')=={'host':'127.0.0.1','tls':29443,'http':29080},'Storage route differs'
backup=active.with_name(active.stem+'.before-bootstrap-tls.json')
assert not backup.exists(),'Backup already exists; inspect before rerunning'
backup.write_bytes(active.read_bytes());backup.chmod(0o600)
routes[hostname]={'host':'127.0.0.1','tls':28443,'http':28080}
candidate=base/'provider-prepared.json';candidate.write_text(json.dumps(doc,indent=2)+'\n');candidate.chmod(0o600)
subprocess.run(['systemctl','daemon-reload'],check=True)
print(json.dumps({'region':region,'hostname':hostname,'prepared':True,'activeSHA256':hashlib.sha256(active.read_bytes()).hexdigest(),'candidateSHA256':hashlib.sha256(candidate.read_bytes()).hexdigest(),'providerNotRestarted':True}))

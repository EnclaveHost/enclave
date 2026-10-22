from pathlib import Path
import subprocess
base=Path('/var/lib/enclave-control-tunnel');subprocess.run(['install','-o','enclave-control-tunnel','-g','enclave-control-tunnel','-m','0600','/tmp/control-provider-known-hosts',str(base/'known_hosts')],check=True)
for region,address in [('us-west','134.199.235.187'),('eu-central','134.209.248.172'),('ap-southeast','165.245.191.129'),('ca-east','146.190.246.39')]:
 p=Path('/etc/systemd/system/enclave-control-tunnel-'+region+'.service');assert not p.exists(),'Existing tunnel unit; inspect before rerunning'
 p.write_text('''[Unit]
Description=Encrypted control and DNS ingress via REGION
After=network-online.target
Wants=network-online.target
[Service]
User=enclave-control-tunnel
Group=enclave-control-tunnel
ExecStart=/usr/bin/ssh -NT -i /var/lib/enclave-control-tunnel/id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/var/lib/enclave-control-tunnel/known_hosts -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=15 -R 127.0.0.1:30443:127.0.0.1:30443 -R 127.0.0.1:30080:127.0.0.1:30080 -R 127.0.0.1:31053:127.0.0.1:1053 enclave-control-tunnel@ADDRESS
Restart=always
RestartSec=10
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
[Install]
WantedBy=multi-user.target
'''.replace('REGION',region).replace('ADDRESS',address))
subprocess.run(['systemctl','daemon-reload'],check=True)
for region in ['us-west','eu-central','ap-southeast','ca-east']:subprocess.run(['systemctl','enable','--now','enclave-control-tunnel-'+region],check=True,capture_output=True)
print('Four persistent restricted control tunnels started; public routes unchanged.')

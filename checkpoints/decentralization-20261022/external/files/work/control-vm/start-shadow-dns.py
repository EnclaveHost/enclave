from pathlib import Path
import subprocess,json
base=Path('/var/lib/enclave-migration');env=base/'preflight/dns-shadow.env';env.write_text('DNS_PORT=1053\nDNS_BIND=127.0.0.1\nDNS_API_PORT=8153\nDNS_API_BIND=127.0.0.1\n');env.chmod(0o600)
source=base/'staged/etc/enclave-dns/dns.env';assert source.is_file()
cmd=['systemd-run','--unit=enclave-dns-shadow','--property=DynamicUser=yes','--property=NoNewPrivileges=yes','--property=PrivateTmp=yes','--property=ProtectSystem=strict','--property=ProtectHome=yes','--property=MemoryMax=256M','--property=WorkingDirectory=/opt/enclave-dns','--property=EnvironmentFile='+str(source),'--property=EnvironmentFile='+str(env),'/usr/local/lib/enclave-node/node','/opt/enclave-dns/dns-relay.js']
subprocess.run(cmd,check=True,capture_output=True);print(json.dumps({'shadowDNSStarted':True,'dnsPort':1053,'apiPort':8153,'bind':'127.0.0.1','productionDelegationChanged':False}))

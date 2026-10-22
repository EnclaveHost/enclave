from pathlib import Path
import json,subprocess,hashlib,sys
host=sys.argv[1];addresses={'us-west':'134.199.235.187','eu-central':'134.209.248.172','ap-southeast':'165.245.191.129','ca-east':'146.190.246.39'};ip=addresses[host]
static=json.loads(Path('work/control-vm/dns-static-inventory.json').read_text())['APP_STATIC'];names=','.join('ns-'+x+'.enclave.host' for x in addresses)
config=Path('work/control-vm/dns-router.conf').read_text().replace("setLocal('127.0.0.1:2053')","setLocal('"+ip+":53')").replace("setACL({'127.0.0.0/8', '::1/128'})","setACL({'0.0.0.0/0', '::/0'})").replace('127.0.0.1:2054','127.0.0.1:1053').replace('127.0.0.1:2055','127.0.0.1:31053')
base=Path('work/control-vm');candidate=base/('dns-front-'+host+'.conf');candidate.write_text(config)
bundle=Path('work/dns-delegation-bundle/dns.mjs');digest=hashlib.sha256(bundle.read_bytes()).hexdigest();assert digest=='8d8fddc5d9a6a67f8aea0af0520d89f6d1b410f8da477689b46cabb411c7462d'
subprocess.run(['scp','-q',str(candidate),host+':/tmp/enclave-dns-front.conf'],check=True);subprocess.run(['scp','-q',str(bundle),host+':/tmp/enclave-dns-ns-set.mjs'],check=True)
script='''from pathlib import Path
import hashlib,subprocess,json
assert hashlib.sha256(Path('/tmp/enclave-dns-ns-set.mjs').read_bytes()).hexdigest()==DIGEST
root=Path('/etc/enclave-dns-front');root.mkdir(mode=0o755,exist_ok=True)
config=root/'dnsdist.conf';config.write_bytes(Path('/tmp/enclave-dns-front.conf').read_bytes())
r=subprocess.run(['dnsdist','--check-config','-C',str(config)],capture_output=True,text=True);assert r.returncode==0,r.stderr
release=Path('/opt/enclave-route-dns/ns-set-8d8fddc');release.mkdir(mode=0o755,exist_ok=True);(release/'dns.mjs').write_bytes(Path('/tmp/enclave-dns-ns-set.mjs').read_bytes());(release/'dns.mjs').chmod(0o644)
dropin='[Service]\\nExecStart=\\nExecStart=/usr/local/bin/node /opt/enclave-route-dns/ns-set-8d8fddc/dns.mjs\\nEnvironment=DNS_BIND=127.0.0.1\\nEnvironment=DNS_PORT=1053\\nEnvironment=NS_NAME=ns-us-west.enclave.host\\nEnvironment=NS_NAMES='+NAMES+'\\nEnvironment=APP_STATIC='+STATIC+'\\nEnvironment=DNS_RL_CAP=20000\\nEnvironment=DNS_RL_PER_SEC=5000\\n'
(root/'route-dropin.prepared').write_text(dropin)
unit='''+repr('''[Unit]
Description=Authoritative DNS front for verified routes and authenticated challenge authority
After=network-online.target enclave-route-dns.service
Wants=network-online.target enclave-route-dns.service
StartLimitIntervalSec=0
[Service]
DynamicUser=yes
ExecStartPre=/usr/bin/dnsdist --check-config -C /etc/enclave-dns-front/dnsdist.conf
ExecStart=/usr/bin/dnsdist --supervised --disable-syslog -C /etc/enclave-dns-front/dnsdist.conf
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=192M
TasksMax=64
[Install]
WantedBy=multi-user.target
''')+'''
(root/'service.prepared').write_text(unit)
print(json.dumps({'prepared':True,'bundleSHA256':DIGEST,'productionListenersChanged':False}))
'''
script='DIGEST='+repr(digest)+'\nNAMES='+repr(names)+'\nSTATIC='+repr(static)+'\n'+script
r=subprocess.run(['ssh','-o','BatchMode=yes',host,'python3','-'],input=script,capture_output=True,text=True);assert r.returncode==0,r.stderr[-1500:];print(host+': '+r.stdout.strip())

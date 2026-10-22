from pathlib import Path
import subprocess,json,urllib.request,time,hashlib,datetime
root=Path('/home/steven/Documents/Codex/2026-10-18/wo');release='2fadb2a';bundle=root/'work/enclave-dns-read-only.mjs';sha=hashlib.sha256(bundle.read_bytes()).hexdigest();rows=[]
opts=['-o','BatchMode=yes','-o','ControlMaster=auto','-o','ControlPersist=60','-o','ControlPath='+str(root/'work/ssh-%h-%p')]
def ssh(host,script):return subprocess.check_output(['ssh',*opts,'root@'+host,'bash','-s'],input=script,text=True,timeout=45)
def get(url):
 with urllib.request.urlopen(url,timeout=25) as r:return json.load(r)
for name,ip in [('us-west','134.199.235.187'),('eu-central','134.209.248.172'),('ap-southeast','165.245.191.129'),('ca-east','146.190.246.39')]:
 preflight=r'''set -eu
if test -e /etc/systemd/system/enclave-route-dns.service; then
 grep -qF 'ExecStart=/usr/local/bin/node /opt/enclave-route-dns/2fadb2a/dns.mjs' /etc/systemd/system/enclave-route-dns.service
else
python3 - <<'CHECK'
import socket
for kind in [socket.SOCK_STREAM,socket.SOCK_DGRAM]:
 s=socket.socket(socket.AF_INET,kind);s.bind(('ADDRESS',53));s.close()
CHECK
fi
'''.replace('ADDRESS',ip)
 ssh(ip,preflight)
 subprocess.run(['scp','-q',*opts,str(bundle),'root@'+ip+':/tmp/enclave-route-dns-'+release+'.mjs'],check=True,timeout=45)
 script=r'''set -eu
install -d -m 0755 /opt/enclave-route-dns/RELEASE
install -m 0644 /tmp/enclave-route-dns-RELEASE.mjs /opt/enclave-route-dns/RELEASE/dns.mjs
cat > /etc/systemd/system/enclave-route-dns.service <<'UNIT'
[Unit]
Description=Enclave DNS route replica from local verified directory (not delegated)
After=network-online.target enclave-public-directory.service
Wants=network-online.target enclave-public-directory.service
[Service]
Type=simple
DynamicUser=yes
ExecStart=/usr/local/bin/node /opt/enclave-route-dns/RELEASE/dns.mjs
Environment=DNS_READ_ONLY=1
Environment=ROUTE_MAP_URL=http://127.0.0.1:8188/v1/network/routes
Environment=IP_ZONE=ip.enclave.host
Environment=APP_ZONE=app.enclave.host
Environment=NS_NAME=ns-NAME.enclave.host
Environment=DNS_BIND=ADDRESS
Environment=DNS_PORT=53
Environment=DNS_API_PORT=8154
Environment=DNS_API_BIND=127.0.0.1
Environment=NET_POLL_SEC=5
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=192M
TasksMax=64
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable enclave-route-dns.service
systemctl restart enclave-route-dns.service
ufw allow 53/udp comment 'Enclave route DNS replica' >/dev/null
ufw allow 53/tcp comment 'Enclave route DNS replica' >/dev/null
systemctl is-active enclave-route-dns.service
sha256sum /opt/enclave-route-dns/RELEASE/dns.mjs
'''.replace('RELEASE',release).replace('ns-NAME.enclave.host','ns-'+name+'.enclave.host').replace('ADDRESS',ip)
 try:
  installed=ssh(ip,script);assert sha in installed
  answers={}
  for mode in ['udp','tcp']:
   for attempt in range(10):
    args=['dig','@'+ip,'7ae476a3.app.enclave.host','A','+short','+time=3','+tries=1']+(['+tcp'] if mode=='tcp' else [])
    answer=subprocess.run(args,text=True,capture_output=True,timeout=5)
    addresses=[s for s in answer.stdout.splitlines() if s and all(c in '0123456789.' for c in s)]
    local=get('http://'+ip+':8188/v1/network/routes')['labels'].get('7ae476a3',{}).get('addresses',[])
    if addresses and set(addresses)<=set(local):break
    time.sleep(3)
   assert addresses and set(addresses)<=set(local),(name,mode,addresses,local,answer.stderr)
   assert '62.238.4.214' not in addresses
   answers[mode]=addresses
  systemd=ssh(ip,'systemctl show enclave-route-dns --property=ActiveState --property=NRestarts --property=ExecStart')
  assert '/opt/enclave-route-dns/'+release+'/dns.mjs' in systemd
  rows.append({'host':name,'address':ip,'bundleSha256':sha,'answers':answers,'systemd':systemd.strip()})
  print(name+': public UDP/TCP DNS matches local verified adapter routes',flush=True)
 except Exception:
  ssh(ip,'systemctl disable --now enclave-route-dns.service')
  raise
 report={'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'release':release,'status':'complete' if len(rows)==4 else 'rolling out','replicas':rows,'delegated':False,'scope':'app-zone A records verified; raw TCP/IP-zone and control namespaces remain unverified','certificateChallenges':'disabled in read-only replicas; not migrated','upstream':'local pinned directory only; no nan route-map fallback'}
 (root/'outputs/route-dns-replicas.json').write_text(json.dumps(report,indent=2)+'\n')

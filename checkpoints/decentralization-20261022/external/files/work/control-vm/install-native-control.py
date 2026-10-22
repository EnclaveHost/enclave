from pathlib import Path
import subprocess,json
ssh=['ssh','-p32423','-o','UserKnownHostsFile=work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1']
r=subprocess.run(ssh+['sudo tee /opt/enclave-recovery/discovery.mjs >/dev/null'],input=Path('work/enclave/relay/native-discovery.mjs').read_bytes());assert r.returncode==0
script='''from pathlib import Path
import shutil,subprocess,json
src=Path('/var/lib/enclave-migration/staged/var/lib/enclave-native-ca');dst=Path('/var/lib/enclave-native-ca');assert not dst.exists();shutil.copytree(src,dst);dst.chmod(0o700)
unit=Path('/etc/systemd/system/enclave-native-discovery.service');assert not unit.exists();unit.write_text('[Unit]\\nDescription=Enclave native ENS route discovery\\nAfter=network-online.target enclave-api-relay.service\\n[Service]\\nDynamicUser=yes\\nLoadCredential=ca.pem:/var/lib/enclave-native-ca/ca.pem\\nEnvironment=NATIVE_CA_CERT=%d/ca.pem\\nExecStart=/usr/bin/node /opt/enclave-recovery/discovery.mjs\\nNoNewPrivileges=yes\\nProtectSystem=strict\\nProtectHome=yes\\nPrivateTmp=yes\\nMemoryMax=128M\\nRestart=on-failure\\n[Install]\\nWantedBy=multi-user.target\\n')
p=Path('/etc/enclave-control-tls/caddy.json');x=json.loads(p.read_text());routes=x['apps']['http']['servers']['control']['routes'];routes.insert(0,{'match':[{'path':['/native/*']}],'handle':[{'handler':'reverse_proxy','upstreams':[{'dial':'127.0.0.1:8187'}]}],'terminal':True});routes.insert(0,{'match':[{'path':['/recovery-health']}],'handle':[{'handler':'static_response','status_code':200,'body':'Enclave recovery ingress'}],'terminal':True})
p.write_text(json.dumps(x,indent=2)+'\\n')
subprocess.run(['systemctl','daemon-reload'],check=True);subprocess.run(['systemctl','enable','--now','enclave-native-discovery'],check=True,capture_output=True)
# Reload will be added with the certificate transition; this config is not restarted yet.
print(json.dumps({'nativeDiscoveryActive':True,'controlTLSReloadPending':True}))
'''
r=subprocess.run(ssh+['sudo python3 -'],input=script,text=True,capture_output=True);assert r.returncode==0,r.stderr[-1500:];print(r.stdout)

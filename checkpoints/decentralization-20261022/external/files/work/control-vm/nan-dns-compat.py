from pathlib import Path
import subprocess
script='''from pathlib import Path
import subprocess,json
root=Path('/etc/enclave-dns-compat');root.mkdir(exist_ok=True);cfg=root/'dnsdist.conf'
cfg.write_text("setLocal('62.238.4.214:53')\\naddLocal('[2a01:4f9:c013:bdfd::1]:53')\\nsetACL({'0.0.0.0/0','::/0'})\\nsetMaxTCPClientThreads(2)\\nsetMaxTCPConnectionsPerClient(16)\\n"+''.join("newServer({address='"+ip+":53', checkName='app.enclave.host.',checkType='SOA'})\\n" for ip in ['134.199.235.187','134.209.248.172','165.245.191.129','146.190.246.39'])+"addAction(MaxQPSIPRule(50,32,64,200),DropAction())\\n")
r=subprocess.run(['dnsdist','--check-config','-C',str(cfg)],capture_output=True,text=True);assert r.returncode==0,r.stderr
unit=Path('/etc/systemd/system/enclave-dns-compat.service');assert not unit.exists();unit.write_text('[Unit]\\nDescription=Temporary DNS compatibility forwarding during Nan retirement\\nAfter=network-online.target\\n[Service]\\nDynamicUser=yes\\nExecStart=/usr/bin/dnsdist --supervised --disable-syslog -C /etc/enclave-dns-compat/dnsdist.conf\\nAmbientCapabilities=CAP_NET_BIND_SERVICE\\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\\nNoNewPrivileges=yes\\nProtectSystem=strict\\nProtectHome=yes\\nPrivateTmp=yes\\nMemoryMax=128M\\nRestart=on-failure\\n[Install]\\nWantedBy=multi-user.target\\n')
subprocess.run(['systemctl','daemon-reload'],check=True);subprocess.run(['systemctl','stop','enclave-dns'],check=True)
try:
 subprocess.run(['systemctl','start','enclave-dns-compat'],check=True)
 subprocess.run(['systemctl','is-active','--quiet','enclave-dns-compat'],check=True)
except:
 subprocess.run(['systemctl','stop','enclave-dns-compat']);subprocess.run(['systemctl','start','enclave-dns']);raise
subprocess.run(['systemctl','disable','enclave-dns'],capture_output=True,check=True)
print(json.dumps({'nanDNSAuthorityStopped':True,'temporaryProviderForwarderActive':True}))
'''
r=subprocess.run(['ssh','nan','python3','-'],input=script,text=True,capture_output=True);assert r.returncode==0,r.stderr[-1200:];print(r.stdout)

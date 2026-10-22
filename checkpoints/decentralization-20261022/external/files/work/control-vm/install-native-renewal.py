from pathlib import Path
import subprocess
ssh=['ssh','-p32423','-o','BatchMode=yes','-o','UserKnownHostsFile=work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1']
subprocess.run(ssh+['sudo tee /opt/enclave-recovery/renew-native-cert.py >/dev/null'],input=Path('work/control-vm/renew-native-cert.py').read_bytes(),check=True)
script='''from pathlib import Path
import subprocess
p=Path('/etc/systemd/system/enclave-native-certs.service');assert not p.exists();p.write_text('[Unit]\\nDescription=Renew Enclave native service certificate\\nAfter=enclave-control-tls.service\\n[Service]\\nType=oneshot\\nExecStart=/usr/bin/python3 /opt/enclave-recovery/renew-native-cert.py\\nUMask=0077\\nNoNewPrivileges=yes\\nProtectHome=yes\\nPrivateTmp=yes\\n')
p=Path('/etc/systemd/system/enclave-native-certs.timer');assert not p.exists();p.write_text('[Unit]\\nDescription=Refresh Enclave native service certificates\\n[Timer]\\nOnBootSec=5min\\nOnUnitActiveSec=12h\\nRandomizedDelaySec=15min\\nPersistent=true\\n[Install]\\nWantedBy=timers.target\\n')
subprocess.run(['python3','/opt/enclave-recovery/renew-native-cert.py','--force'],check=True)
subprocess.run(['systemctl','daemon-reload'],check=True);subprocess.run(['systemctl','enable','--now','enclave-native-certs.timer'],check=True,capture_output=True)
'''
r=subprocess.run(ssh+['sudo python3 -'],input=script,text=True,capture_output=True);assert r.returncode==0,r.stderr[-1500:];print(r.stdout)

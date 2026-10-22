from pathlib import Path
import subprocess,json
ssh=['ssh','-p32423','-o','BatchMode=yes','-o','UserKnownHostsFile=work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1']
script='''from pathlib import Path
import subprocess
for p in ['/etc/enclave-control','/etc/enclave-control-tls','/etc/enclave-dns','/etc/nan-relay','/var/lib/enclave-native-ca','/var/lib/private/enclave-relay','/opt/nan-relay','/opt/enclave-recovery']:
 print(subprocess.check_output(['du','-sh',p],text=True).strip())
for p in Path('/etc/systemd/system').glob('enclave-control-tunnel-*.service'):
 for line in p.read_text().splitlines():
  if line.startswith('ExecStart='):print(p.name,line)
'''
r=subprocess.run(ssh+['sudo python3 -'],input=script,text=True,capture_output=True);assert r.returncode==0,r.stderr;print(r.stdout)

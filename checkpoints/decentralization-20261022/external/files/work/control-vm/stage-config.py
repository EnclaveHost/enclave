import subprocess
from pathlib import Path
ssh=['ssh','-p32423','-o','BatchMode=yes','-o','UserKnownHostsFile=work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1']
subprocess.run(ssh+['sudo install -d -m 0700 /var/lib/enclave-migration/staged'],check=True)
with open('work/control-vm/config-transfer-errors.log','wb') as log:
 src=subprocess.Popen(['ssh','-o','BatchMode=yes','nan','python3','-'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log)
 dst=subprocess.Popen(ssh+['sudo tar -C /var/lib/enclave-migration/staged -xzf - --no-same-owner'],stdin=src.stdout,stdout=subprocess.DEVNULL,stderr=log);src.stdout.close()
 src.stdin.write(Path('work/control-vm/config-archive.py').read_bytes());src.stdin.close()
 b=dst.wait();a=src.wait();assert a==0 and b==0,'Config transfer failed'
print('Protected configuration and unit definitions staged; no target services installed or started.')

import subprocess
from pathlib import Path
ssh=['ssh','-p32423','-o','BatchMode=yes','-o','UserKnownHostsFile=work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1']
subprocess.run(ssh+['sudo install -d -m 0755 /usr/local/lib/enclave-node; sudo install -d -m 0700 /var/lib/enclave-migration/preflight'],check=True)
for src,dst,mode in [('/usr/bin/node','/usr/local/lib/enclave-node/node','0755'),('/var/lib/indexd-migration/predictor-replicas-preflight.env','/var/lib/enclave-migration/preflight/predictor.env','0600')]:
 a=subprocess.Popen(['ssh','-o','BatchMode=yes','nan','cat',src],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
 b=subprocess.Popen(ssh+['sudo install -m '+mode+' /dev/stdin '+dst],stdin=a.stdout,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);a.stdout.close();br=b.wait();ar=a.wait();assert ar==0 and br==0,'Preflight transfer failed'
subprocess.run(ssh+['sudo sed -i s@/var/lib/enclave-replica-preflight@/var/lib/enclave-control-preflight@ /var/lib/enclave-migration/preflight/predictor.env'],check=True)
print('Isolated predictor environment and exact Node binary staged; no relay signing credentials loaded.')

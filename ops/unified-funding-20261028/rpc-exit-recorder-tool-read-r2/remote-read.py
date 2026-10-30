import os,json,subprocess,hashlib,stat,time
from pathlib import Path
caps={'enclave-api-relay.service': 1536, 'enclave-control-tls.service': 256, 'enclave-dns.service': 256, 'enclave-native-discovery.service': 128, 'enclave-policy-migration-bridge.service': 256, 'enclave-provider-migration-mirror.service': 192, 'enclave-rpc-gateway.service': 192}
assert os.geteuid()==0
boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip();assert boot=='b39ecfe2-82b2-4c2a-a596-a52630bb59fd'
available=next(int(x.split()[1])*1024 for x in Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:'))
growth=0
for name,mib in caps.items():
 p=Path('/sys/fs/cgroup/system.slice')/name;maximum=int((p/'memory.max').read_text());assert maximum==mib*(1<<20)
 growth+=max(0,maximum-int((p/'memory.current').read_text()))
assert available-growth>=1600*(1<<20),'observer OS residual'
rows=[]
for name in ['/usr/bin/taskset','/usr/bin/systemd-run','/usr/bin/journalctl']:
 p=Path(name);q=p.resolve(strict=True);s=q.stat();assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022
 with q.open('rb') as f:h=hashlib.file_digest(f,'sha256').hexdigest()
 rows.append({'path':name,'realpath':str(q),'device':s.st_dev,'inode':s.st_ino,'mode':s.st_mode,'uid':s.st_uid,'gid':s.st_gid,'bytes':s.st_size,'sha256':h})
r=subprocess.run(['/usr/bin/systemctl','--version'],capture_output=True,text=True,check=True,timeout=2);assert len(r.stdout)<=4096
print(json.dumps({'at':time.time(),'boot':boot,'availableBytes':available,'remainingServiceGrowthBytes':growth,'OSResidualBytes':available-growth,'binaries':rows,'systemdVersion':r.stdout,'readOnly':True,'clientStarted':False}))

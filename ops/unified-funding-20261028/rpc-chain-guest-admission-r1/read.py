import os,json,time,hashlib,subprocess
from pathlib import Path
paths=['/home/controladmin/rpc-storage-client-package-20261031-r3/storage-client.tar', '/home/controladmin/rpc-media-tools-20261031-r1/tools/usr/bin/xorriso', '/usr/bin/openssl', '/usr/bin/ssh-keygen']
rows={}
for name in paths:
 p=Path(name);s=p.stat()
 assert s.st_size<16*1024**2 and not p.is_symlink()
 with p.open('rb')as f:sha=hashlib.file_digest(f,'sha256').hexdigest()
 rows[name]={'bytes':s.st_size,'sha256':sha}
assert not Path('/home/controladmin/rpc-chain-guest-5a1f71bc826e4c5abf0166938d448c68').exists()
mem={x.split(':')[0]:int(x.split()[1])*1024 for x in Path('/proc/meminfo').read_text().splitlines()if x.split(':')[0]in('MemTotal','MemAvailable')}
disk=os.statvfs('/home/controladmin');assert mem['MemAvailable']>=2*1024**3+256*1024**2 and disk.f_bavail*disk.f_frsize>=16*1024**3
pid=os.getpid();start=Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19]
print(json.dumps({'atUtcNs':time.time_ns(),'boot':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'uid':os.geteuid(),'pid':pid,'start':start,'invocation':os.environ.get('INVOCATION_ID'),'memory':mem,'diskFreeBytes':disk.f_bavail*disk.f_frsize,'files':rows,'newRootAbsent':True,'readOnly':True}))

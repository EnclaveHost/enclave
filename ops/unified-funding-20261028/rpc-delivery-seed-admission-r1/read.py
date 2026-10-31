from pathlib import Path
import json,hashlib,subprocess,os,time
boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
assert boot=='b39ecfe2-82b2-4c2a-a596-a52630bb59fd'
mem=next(int(x.split()[1])*1024 for x in Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:'))
disk=os.statvfs('/home/controladmin');free=disk.f_bavail*disk.f_frsize
assert mem>=2*1024**3+128*1024**2 and free>=16*1024**3
pins={}
for name in ['openssl','ssh-keygen']:
 p=Path('/usr/bin')/name;assert p.resolve()==p
 with p.open('rb') as f:h=hashlib.file_digest(f,'sha256').hexdigest()
 pins[name]={'path':str(p),'sha256':h}
existing=Path('/home/controladmin/rpc-activation-guest-20582821672b46d0b13443ed7f6ff6a3/output/seed.iso')
with existing.open('rb') as f:assert hashlib.file_digest(f,'sha256').hexdigest()=='e0cfb85459e0ada71835a94e53ede61cf25f07878e41146d358c8b613dd141a6'
schema=Path('/usr/bin/cloud-init');assert schema.is_file()
r=subprocess.run([str(schema),'--version'],capture_output=True,text=True,timeout=3)
assert r.returncode==0 and len(r.stdout)+len(r.stderr)<4096
print(json.dumps({'bootId':boot,'memAvailableBytes':mem,'diskFreeBytes':free,'tools':pins,'cloudInitVersion':(r.stdout+r.stderr).strip(),'atUtcNs':time.time_ns(),'invocation':os.environ.get('INVOCATION_ID'),'readOnly':True}))

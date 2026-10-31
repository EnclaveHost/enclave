from pathlib import Path
import json,hashlib,subprocess,time,os
p=Path('/home/controladmin/rpc-guest-image-20261031-r1/output')
result=json.loads((p/'RESULT.json').read_text());start=time.monotonic()
mem=next(int(x.split()[1])*1024 for x in Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:'));assert mem>=2*1024**3
with (p/'boot.vhdx').open('rb') as f:actual=hashlib.file_digest(f,'sha256').hexdigest()
assert actual==result['sha256']
root=p/'root.ext4';debug='/usr/sbin/debugfs'
assert hashlib.sha256(Path(debug).read_bytes()).hexdigest()=='1e83118cc9582afcad2711fbb7f40f56668adccb386d988cb6d9ad5c2d001049'
def read(cmd):
 r=subprocess.run([debug,'-R',cmd,str(root)],capture_output=True,text=True,timeout=5);assert r.returncode==0;return {'stdout':r.stdout,'stderr':r.stderr}
passwd=read('cat /etc/passwd');group=read('cat /etc/group')
accounts=[dict(name=x[0],uid=int(x[2]),gid=int(x[3])) for line in passwd['stdout'].splitlines() if (x:=line.split(':')) and len(x)==7 and (int(x[2])>=990 or x[0].startswith('rpc'))]
groups=[dict(name=x[0],gid=int(x[2])) for line in group['stdout'].splitlines() if (x:=line.split(':')) and len(x)==4 and int(x[2])>=980]
tools={name:read('stat '+name) for name in ['/usr/bin/python3.12','/usr/sbin/nbd-client','/usr/bin/nbd-client','/usr/bin/nbdfuse','/usr/bin/qemu-nbd']}
logs={x.name:x.read_text() for x in p.glob('step-*.txt')};assert sum(len(x) for x in logs.values())<100000
print(json.dumps({'at':time.time(),'sha256':actual,'bytes':(p/'boot.vhdx').stat().st_size,'hashAgrees':True,'seconds':time.monotonic()-start,'accounts':accounts,'groups':groups,'tools':tools,'logs':logs,'invocation':os.environ.get('INVOCATION_ID')}))

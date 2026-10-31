from pathlib import Path
import subprocess,json,hashlib,re,os
root='/home/controladmin/rpc-guest-image-20261031-r1/output/root.ext4'
tool='/usr/sbin/debugfs';assert hashlib.sha256(Path(tool).read_bytes()).hexdigest()=='1e83118cc9582afcad2711fbb7f40f56668adccb386d988cb6d9ad5c2d001049'
def read(command):
 r=subprocess.run([tool,'-R',command,root],capture_output=True,text=True,timeout=5);assert r.returncode==0 and len(r.stdout)+len(r.stderr)<16384
 return {'stdout':r.stdout,'stderr':r.stderr}
versions=read('ls -p /usr/lib/modules');names=re.findall(r'/(6\.[^/]+)/',versions['stdout']);assert len(names)<=4
rows={name:{path:read('stat /usr/lib/modules/'+name+'/'+path) for path in ['kernel/drivers/block/nbd.ko','kernel/drivers/block/nbd.ko.zst','kernel/drivers/block/nbd.ko.xz','modules.dep']} for name in names}
tools={name:read('stat '+name) for name in ['/usr/sbin/modprobe','/usr/bin/kmod','/usr/sbin/blkid','/usr/bin/mount','/usr/bin/umount','/usr/sbin/groupadd','/usr/sbin/useradd']}
print(json.dumps({'versions':versions,'modules':rows,'tools':tools,'readOnly':True,'kernelExecuted':False,'invocation':os.environ.get('INVOCATION_ID')}))

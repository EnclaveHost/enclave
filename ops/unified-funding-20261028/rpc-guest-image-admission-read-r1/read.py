import json,os,pathlib,subprocess,time,hashlib
p=pathlib.Path
out={'at':time.time(),'boot':p('/proc/sys/kernel/random/boot_id').read_text().strip(),'availableBytes':next(int(x.split()[1])*1024 for x in p('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:')),'tools':{}}
for name in ['/usr/sbin/debugfs','/usr/sbin/e2fsck','/home/controladmin/rpc-media-tools-20261031-r1/tools/usr/bin/qemu-img']:
 q=p(name);out['tools'][name]={'exists':q.is_file()}
 if q.is_file():
  with q.open('rb') as f:out['tools'][name].update({'bytes':q.stat().st_size,'sha256':hashlib.file_digest(f,'sha256').hexdigest()})
v=os.statvfs('/home/controladmin');out['diskFreeBytes']=v.f_bavail*v.f_frsize
for name,args in [('jobs',['systemctl','list-jobs','--no-legend','--no-pager']),('timers',['systemctl','list-timers','--all','--no-pager']),('processes',['ps','-eo','pid,ppid,etimes,rss,comm'])]:
 r=subprocess.run(args,capture_output=True,text=True,timeout=3);out[name]={'exit':r.returncode,'text':r.stdout[:20000]}
out['newWorkspaceAbsent']=not p('/home/controladmin/rpc-guest-image-20261031-r1').exists()
print(json.dumps(out))

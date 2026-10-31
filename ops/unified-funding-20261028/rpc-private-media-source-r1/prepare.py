from pathlib import Path
import os,time,json,hashlib,stat
os.umask(0o077)
boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip();assert boot=='b39ecfe2-82b2-4c2a-a596-a52630bb59fd'
root=Path('/home/controladmin/rpc-private-media-source-74d42b8883374a60af752dce1955612a')
def resources():
 mem=next(int(x.split()[1])*1024 for x in Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:'))
 disk=os.statvfs(root.parent);free=disk.f_bavail*disk.f_frsize
 assert mem>=2*1024**3+128*1024**2 and free>=16*1024**3
 return {'memAvailableBytes':mem,'diskFreeBytes':free}
before=resources();start=time.monotonic();rows={}
for name,file,size,pin in [('boot.vhdx','/home/controladmin/rpc-guest-image-20261031-r1/output/boot.vhdx',2301624320,'a76940c926985b91590ab5916c7996c23d7812ccc2277fe8188bb21f11a0ae2c'),('seed.iso','/home/controladmin/rpc-delivery-guest-7f345bba3cb8432e9a726435e8ea1c7c/output/seed.iso',13219840,'58e9efdd7cdf373e6bcc4ae171b706e4b4a355e77a7ebf27ecba5cdb4d5f996f')]:
 path=Path(file);assert path.resolve()==path
 st=path.stat();assert stat.S_ISREG(st.st_mode) and st.st_uid==os.geteuid() and st.st_nlink==1 and stat.S_IMODE(st.st_mode)==0o600 and st.st_size==size
 if name=='seed.iso':
  for parent in [path.parent,path.parent.parent]:
   x=parent.stat();assert x.st_uid==os.geteuid() and stat.S_IMODE(x.st_mode)==0o700
 with path.open('rb') as f:h=hashlib.file_digest(f,'sha256').hexdigest()
 end=path.stat();assert h==pin and (st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns)==(end.st_dev,end.st_ino,end.st_size,end.st_mtime_ns,end.st_ctime_ns)
 rows[name]={'path':file,'bytes':size,'sha256':pin,'mode':'0600','metadata':[st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns]}
 resources();assert time.monotonic()-start<90
root.mkdir(mode=0o700);data=b'owned RPC private custody probe v1\n';probe=root/'custody-probe.bin'
with probe.open('xb') as f:f.write(data);f.flush();os.fsync(f.fileno())
rows['custody-probe.bin']={'path':str(probe),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'mode':'0600'}
print(json.dumps({'verified':True,'files':rows,'bootId':boot,'before':before,'after':resources(),'atUtcNs':time.time_ns(),'seconds':time.monotonic()-start,'invocation':os.environ.get('INVOCATION_ID'),'privateContentsPrinted':False,'vmChanged':False}))

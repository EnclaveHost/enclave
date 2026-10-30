from pathlib import Path
import os,stat,fcntl,struct,hashlib,json,time
p=Path(__file__).resolve().parent
q=Path('/vm/enclave-volumes/rpc-control-l1-client-r6/overlay.qcow2')
assert os.sched_getaffinity(0)=={1}
with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'readOnly':True},f)
started=time.monotonic();before=q.lstat()
assert stat.S_ISREG(before.st_mode) and before.st_uid==1000 and stat.S_IMODE(before.st_mode)==0o600 and before.st_nlink==1 and before.st_size<=512<<20
parents={}
for parent in q.parents:
 st=parent.lstat();assert stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode) and st.st_uid in (0,1000) and not st.st_mode&0o022
 parents[str(parent)]=[st.st_dev,st.st_ino,st.st_uid,st.st_mode]
fields=('st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns','st_mode','st_uid','st_gid','st_nlink')
identity=lambda s:[getattr(s,k) for k in fields]
fd=os.open(q,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
try:
 assert identity(os.fstat(fd))==identity(before)
 for byte in (201,202,203):fcntl.fcntl(fd,fcntl.F_OFD_SETLK,struct.pack('@hhqqi4x',fcntl.F_RDLCK,os.SEEK_SET,byte,1,0))
 occupied=fcntl.fcntl(fd,fcntl.F_OFD_GETLK,struct.pack('@hhqqi4x',fcntl.F_WRLCK,os.SEEK_SET,100,200,0));assert struct.unpack('@hhqqi4x',occupied)[0]==fcntl.F_UNLCK
 digest=hashlib.sha256();count=0;header=None
 while True:
  assert time.monotonic()-started<30
  data=os.read(fd,1<<20)
  if not data:break
  if header is None:header=data[:104]
  count+=len(data);assert count<=before.st_size;digest.update(data)
 assert count==before.st_size and identity(os.fstat(fd))==identity(before)==identity(q.lstat())
 for parent,saved in parents.items():
  st=Path(parent).lstat();assert [st.st_dev,st.st_ino,st.st_uid,st.st_mode]==saved
 assert header[:4]==b'QFI\xfb' and struct.unpack('>I',header[4:8])[0]==3
 result={'at':time.time(),'path':str(q),'identity':dict(zip(fields,identity(before))),'allocatedBytes':before.st_blocks*512,'bytesHashed':count,'sha256':digest.hexdigest(),'header104Sha256':hashlib.sha256(header).hexdigest(),'elapsedSeconds':time.monotonic()-started,'readOnly':True,'qemuCompatibleLocksHeldDuringHash':True,'parents':parents,'originalNotRead':True,'databaseCleanNotProven':True}
 with (p/'RESULT.json').open('x') as f:json.dump(result,f,indent=2);f.write('\n')
 print(json.dumps(result))
finally:os.close(fd)

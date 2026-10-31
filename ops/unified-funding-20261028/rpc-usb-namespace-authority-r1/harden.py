from pathlib import Path
import json,os,stat,time
p=Path(__file__).resolve().parent;c=json.loads((p/'CONFIG.json').read_text());fd=os.open(c['directory'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 s=os.fstat(fd);assert (s.st_dev,s.st_ino,s.st_uid,stat.S_IMODE(s.st_mode))==(c['dev'],c['inode'],c['uid'],c['previousMode'])
 with (p/'INTENT.json').open('x') as f:json.dump({'at':time.time(),'configuration':c,'recursive':False},f);f.flush();os.fsync(f.fileno())
 os.fchmod(fd,c['requiredMode']);os.fsync(fd)
 after=os.fstat(fd);path=Path(c['directory']).lstat();assert (after.st_dev,after.st_ino,after.st_uid,stat.S_IMODE(after.st_mode))==(c['dev'],c['inode'],c['uid'],c['requiredMode']);assert (path.st_dev,path.st_ino)==(after.st_dev,after.st_ino)
 b=Path('/mnt/usb/enclave-rpc-production/base-origin.qcow2').stat();assert [b.st_dev,b.st_ino,b.st_size,b.st_mtime_ns,b.st_ctime_ns,b.st_mode,b.st_uid,b.st_gid]==c['baseMetadata']
 (p/'RESULT.json').write_text(json.dumps({'at':time.time(),'mode':oct(stat.S_IMODE(after.st_mode)),'baseUnchanged':True,'recursive':False})+'\n')
finally:os.close(fd)

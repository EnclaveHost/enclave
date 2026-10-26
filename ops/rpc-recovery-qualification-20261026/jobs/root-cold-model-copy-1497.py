import hashlib,json,os,stat,time
from pathlib import Path
src=Path('/vm/enclave-volumes/.src/fable-fusion-27b-mtp-gguf/Fable-Fusion-27B-MTP-Q5_K_M.gguf')
d=Path('/mnt/usb/enclave-cold-model-sources/fable-fusion-27b-mtp-gguf');d.mkdir(parents=True,exist_ok=True);os.chmod(d,0o755)
out=d/src.name;part=d/(src.name+'.copying-20261026')
assert not out.exists() and not part.exists();a=src.lstat();assert stat.S_ISREG(a.st_mode) and a.st_nlink==1 and a.st_size==21182275040
sv=os.statvfs(d);assert sv.f_bavail*sv.f_frsize>a.st_size+500000000000
ident=lambda s:[s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns]
h=hashlib.sha256();start=time.monotonic();n=0
with src.open('rb') as fi,part.open('xb') as fo:
 while b:=fi.read(8<<20):
  fo.write(b);h.update(b);n+=len(b)
  delay=n/(80<<20)-(time.monotonic()-start)
  if delay>0:time.sleep(delay)
 fo.flush();os.fsync(fo.fileno())
assert ident(src.stat())==ident(a)
h2=hashlib.sha256()
with part.open('rb') as f:
 while b:=f.read(8<<20):h2.update(b)
assert h.hexdigest()==h2.hexdigest() and part.stat().st_size==a.st_size
assert ident(src.stat())==ident(a)
os.chmod(part,stat.S_IMODE(a.st_mode));os.utime(part,ns=(a.st_atime_ns,a.st_mtime_ns));os.rename(part,out)
fd=os.open(d,os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)
r={'source':str(src),'destination':str(out),'size':a.st_size,'sha256':h.hexdigest(),'sourceIdentity':ident(a),'sourceMode':stat.S_IMODE(a.st_mode),'copiedVerified':True,'sourceStillOriginal':True,'elapsed':time.monotonic()-start}
Path('logs/cold-model-copy-1497.json').write_text(json.dumps(r,indent=1)+'\n');print(json.dumps(r,indent=1))

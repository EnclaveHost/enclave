import json, os, stat, subprocess
from pathlib import Path
receipt=Path('logs/cold-model-copy-1497.json')
r=json.loads(receipt.read_text())
assert Path('logs/root-cold-model-copy-1497.rc').read_text().strip()=='0'
assert r['copiedVerified'] is True and r['sourceStillOriginal'] is True
src=Path(r['source']); dst=Path(r['destination'])
assert str(src)=='/vm/enclave-volumes/.src/fable-fusion-27b-mtp-gguf/Fable-Fusion-27B-MTP-Q5_K_M.gguf'
assert str(dst)=='/mnt/usb/enclave-cold-model-sources/fable-fusion-27b-mtp-gguf/Fable-Fusion-27B-MTP-Q5_K_M.gguf'
identity=lambda s:[s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns]
a=src.lstat();b=dst.lstat()
assert stat.S_ISREG(a.st_mode) and stat.S_ISREG(b.st_mode)
assert identity(a)==r['sourceIdentity'] and a.st_nlink==1
assert a.st_size==b.st_size==r['size'] and a.st_mtime_ns==b.st_mtime_ns
assert stat.S_IMODE(a.st_mode)==stat.S_IMODE(b.st_mode)==r['sourceMode']
assert a.st_dev!=b.st_dev and a.st_uid==b.st_uid==os.getuid()
fd=os.open(dst,os.O_RDONLY);os.fsync(fd);os.close(fd)
held=subprocess.run(['fuser','--',str(src)],capture_output=True,timeout=15)
assert held.returncode==1 and not held.stdout.strip() and not held.stderr.strip(),held
tmp=src.with_name(src.name+'.verified-usb-link-1503')
assert not tmp.exists() and not tmp.is_symlink()
free=lambda:os.statvfs(src.parent).f_bavail*os.statvfs(src.parent).f_frsize
before=free()
os.symlink(str(dst),tmp)
try:
 assert identity(src.lstat())==r['sourceIdentity']
 assert identity(dst.lstat())==identity(b)
 os.replace(tmp,src)
 fd=os.open(src.parent,os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)
finally:
 if tmp.is_symlink():tmp.unlink()
assert src.is_symlink() and src.resolve()==dst and src.stat().st_size==r['size']
result={'source':str(src),'destination':str(dst),'verifiedCopyReceipt':str(receipt),'sha256':r['sha256'],'bytes':r['size'],'originalAllocatedBytes':a.st_blocks*512,'freeBefore':before,'freeAfter':free(),'cachePathPreserved':True,'liveModelVolumeChanged':False}
Path('logs/cold-model-relocate-1503.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))

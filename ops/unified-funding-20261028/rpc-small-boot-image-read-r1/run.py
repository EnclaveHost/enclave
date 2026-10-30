from pathlib import Path
import os,json,hashlib,struct,subprocess,time
p=Path(__file__).resolve().parent;b=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/storage-vm/image/noble-server-cloudimg-amd64.img')
assert os.sched_getaffinity(0)=={1}
with (p/'ATTEMPT.json').open('x')as f:json.dump({'at':time.time(),'readOnly':True},f)
s=b.stat();assert b.is_file() and not b.is_symlink() and s.st_size==621284352
with b.open('rb')as f:
 head=f.read(104);assert head[:4]==b'QFI\xfb' and struct.unpack('>Q',head[8:16])[0]==0 and struct.unpack('>I',head[16:20])[0]==0
 f.seek(0);h=hashlib.sha256()
 for c in iter(lambda:f.read(1048576),b''):h.update(c)
assert h.hexdigest()=='04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94'
r=subprocess.run(['/usr/bin/qemu-img','info','--output=json','-f','qcow2',str(b)],capture_output=True,timeout=5)
assert r.returncode==0 and len(r.stdout)<65536 and len(r.stderr)<16384
s2=b.stat();assert (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)==(s2.st_dev,s2.st_ino,s2.st_size,s2.st_mtime_ns,s2.st_ctime_ns)
(p/'RESULT.json').write_text(json.dumps({'at':time.time(),'sha256':h.hexdigest(),'stat':{'device':s.st_dev,'inode':s.st_ino,'bytes':s.st_size,'mode':oct(s.st_mode&4095)},'image':json.loads(r.stdout),'mutation':False,'signatureIndependentlyVerified':False,'bootQualified':False},indent=2)+'\n')

from pathlib import Path
import os,stat,time,hashlib,base64,random,json,shutil,datetime
names=['tmpg_lof3s0','tmpv9bietok','tmpnscw_6u1','tmpd8yoe8a7','tmpt9jth269','tmp2huu4mz2','tmpp8g4d936','tmpqefzv84n','tmpc9mh9prp','tmpbt0di8p9','tmpogr6yc3b','tmpxgyz_6b_','tmpt1f_d085','tmpjsv39o93']
rng=random.Random(7);data=bytes(rng.getrandbits(8) for _ in range(10007));cb=1440;k=(len(data)+cb-1)//cb
lines=[f'VSOCK STDERR-EXPORT v1 scope=snapshot-after-engine-main-cleanup file_bytes={len(data)} from=0 total={len(data)} chunk_bytes={cb} chunks={k} sha256={hashlib.sha256(data).hexdigest()} truncated=0']
for i in range(k):
 c=data[i*cb:(i+1)*cb];lines.append(f'VSOCK STDERR-CHUNK {i} {i*cb} {len(c)} {hashlib.sha256(c).hexdigest()[:16]} {base64.b64encode(c).decode()}')
lines.append(f'VSOCK STDERR-END v1 chunks={k} total={len(data)} sha256={hashlib.sha256(data).hexdigest()}')
prefix=('\n'.join(lines)+'\n').encode();tail=(128<<20)+10
h=hashlib.sha256(prefix);left=tail
while left:
 n=min(left,1<<20);h.update(b'x'*n);left-=n
expected=h.hexdigest();size=len(prefix)+tail
root=Path('work/archived-stderr-fixtures').resolve();root.mkdir(exist_ok=True)
def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1<<20),b''):h.update(b)
 return h.hexdigest()
def unused(p):
 for proc in Path('/proc').iterdir():
  if not proc.name.isdigit():continue
  for obj in [proc/'cwd',proc/'root',*list((proc/'fd').glob('*'))]:
   try:t=os.readlink(obj)
   except OSError:continue
   if t==str(p) or t.startswith(str(p)+'/'):raise RuntimeError(f'active process {proc.name} references {p}')
verified=[]
for name in names:
 p=Path('/tmp')/name
 assert p.is_dir() and not p.is_symlink() and p.stat().st_uid==os.getuid()
 assert {q.name for q in p.iterdir()}=={'big.log','fifo','link'}
 assert stat.S_ISFIFO((p/'fifo').lstat().st_mode) and os.readlink(p/'link')=='/etc/hostname'
 log=p/'big.log';assert log.is_file() and not log.is_symlink() and log.stat().st_size==size
 assert time.time()-log.stat().st_mtime>86400 and digest(log)==expected
 assert not (root/name).exists();unused(p);verified.append(p)
rows=[]
for p in verified:
 dst=root/p.name;dst.mkdir(mode=p.stat().st_mode&0o777);shutil.copy2(p/'big.log',dst/'big.log')
 os.mkfifo(dst/'fifo',(p/'fifo').lstat().st_mode&0o777);os.symlink('/etc/hostname',dst/'link')
 assert digest(dst/'big.log')==expected
 with (dst/'big.log').open('rb') as f:os.fsync(f.fileno())
 fd=os.open(dst,os.O_DIRECTORY);os.fsync(fd);os.close(fd)
 unused(p);assert digest(p/'big.log')==expected
 backup=p.with_name(p.name+'.stderr-archiving');assert not backup.exists();p.rename(backup)
 try:os.symlink(dst,p,target_is_directory=True)
 except BaseException:backup.rename(p);raise
 assert digest(p/'big.log')==expected
 for child in backup.iterdir():child.unlink()
 backup.rmdir()
 rows.append({'original':str(p),'archive':str(dst),'sha256':expected,'bytes':size,'preservedPath':True})
e={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'kind':'reversible relocation of completed synthetic fixtures off tmpfs','sourceFixture':'work/enclave/test/stderr-collect.test.py:60','verified':'exact expected synthetic bytes, FIFO/symlink layout, uid, age>24h, no process cwd/root/open-fd references before relocation','directories':rows,'tmpfsBytesReleased':sum(r['bytes'] for r in rows),'noProcessesStopped':True}
Path('outputs/decentralization-audit/test-fixture-memory-recovery.json').write_text(json.dumps(e,indent=2)+'\n')
print(json.dumps({'archived':len(rows),'tmpfsBytesReleased':e['tmpfsBytesReleased'],'preserved':True}))

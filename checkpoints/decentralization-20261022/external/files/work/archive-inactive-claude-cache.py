from pathlib import Path
import os,stat,time,hashlib,shutil,json,datetime
base=Path('/tmp/claude-1000/-home-steven-Projects-enclave/dae833a2-3bdf-40f8-9efb-c955c5529336/scratchpad')
sources=[base/'spike/target',base/'muxcopy/target',base/'adapter-main/s3-ipfs-adapter/target']
archive=Path('work/archived-claude-cache').resolve();archive.mkdir(mode=0o700,exist_ok=True);os.chmod(archive,0o700)
def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
def idle(src):
 for proc in Path('/proc').iterdir():
  if not proc.name.isdigit():continue
  try:
   cmd=(proc/'cmdline').read_bytes()
   if str(src).encode() in cmd:raise RuntimeError(f'live process references session {proc.name}')
  except (OSError,PermissionError):pass
  for obj in [proc/'cwd',proc/'root',*list((proc/'fd').glob('*'))]:
   try:t=os.readlink(obj)
   except OSError:continue
   if t==str(src) or t.startswith(str(src)+'/'):raise RuntimeError(f'live file reference {proc.name}')
rows=[]
for src in sources:
 assert src.is_dir() and not src.is_symlink() and src.stat().st_uid==os.getuid()
 idle(src); manifest={}
 for p in src.rglob('*'):
  s=p.lstat();assert s.st_uid==os.getuid();assert time.time()-s.st_mtime>4*86400
  assert stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode), 'unsupported cache object'
  if p.is_file():manifest[str(p.relative_to(src))]={'size':s.st_size,'mtime':s.st_mtime_ns,'sha256':digest(p),'mode':stat.S_IMODE(s.st_mode)}
 dst=archive/(src.parent.name+'-target');assert not dst.exists();shutil.copytree(src,dst,copy_function=shutil.copy2)
 for rel,m in manifest.items():
  p=dst/rel;assert p.stat().st_size==m['size'] and digest(p)==m['sha256']
  with p.open('rb') as f:os.fsync(f.fileno())
 for d in [*sorted([q for q in dst.rglob('*') if q.is_dir()],key=lambda q:len(q.parts),reverse=True),dst,archive]:
  fd=os.open(d,os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)
 idle(src)
 for rel,m in manifest.items():
  p=src/rel;assert p.stat().st_size==m['size'] and p.stat().st_mtime_ns==m['mtime'] and digest(p)==m['sha256']
 tmp=src.with_name(src.name+'.cache-relocation');assert not tmp.exists();src.rename(tmp)
 try:os.symlink(dst,src,target_is_directory=True)
 except BaseException:tmp.rename(src);raise
 for rel,m in manifest.items():assert digest(src/rel)==m['sha256']
 shutil.rmtree(tmp)
 rows.append({'original':str(src),'archive':str(dst),'files':len(manifest),'bytes':sum(m['size'] for m in manifest.values()),'manifest':manifest})
report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'operation':'reversible opaque relocation of inactive Claude temporary outputs from tmpfs to disk; original paths preserved as symlinks','verified':'UID, regular files/directories only, all older than four days, no active process command/cwd/root/open-fd references, every copied byte hash verified, fsync before original tmpfs copy removal','noProcessesStopped':True,'contentsNotInterpretedOrPrinted':True,'directories':rows,'tmpfsBytesReleased':sum(r['bytes'] for r in rows)}
Path('work/archived-claude-cache/relocation-manifest.json').write_text(json.dumps(report,indent=2)+'\n')
public={k:v for k,v in report.items() if k!='directories'};public['directories']=[{k:v for k,v in r.items() if k!='manifest'} for r in rows]
Path('outputs/decentralization-audit/inactive-claude-cache-memory-recovery.json').write_text(json.dumps(public,indent=2)+'\n');print(json.dumps(public))

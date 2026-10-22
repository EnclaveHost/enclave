from pathlib import Path
import tarfile,subprocess,sys,json,stat
rows=json.loads(Path('/var/lib/indexd-migration/control-code-manifest.json').read_text())
z=subprocess.Popen(['zstd','-q','-T1','-3','-c'],stdin=subprocess.PIPE,stdout=sys.stdout.buffer)
try:
 with tarfile.open(fileobj=z.stdin,mode='w|',format=tarfile.PAX_FORMAT) as tar:
  for r in rows:
   p=Path('/')/r['path'];s=p.lstat();assert stat.S_IMODE(s.st_mode)==r['mode'] and int(s.st_mtime)==r['mtime'],'Source metadata changed'
   info=tarfile.TarInfo(r['path']);info.mode=r['mode'];info.mtime=r['mtime'];info.uid=info.gid=0
   if r['kind']=='directory':info.type=tarfile.DIRTYPE;tar.addfile(info)
   elif r['kind']=='symlink':info.type=tarfile.SYMTYPE;info.linkname=r['link'];assert p.readlink().as_posix()==r['link'];tar.addfile(info)
   elif 'duplicate' in r:info.type=tarfile.LNKTYPE;info.linkname=r['duplicate'];tar.addfile(info)
   else:
    assert s.st_size==r['size'],'Source size changed';info.size=r['size']
    with p.open('rb') as f:tar.addfile(info,f)
 z.stdin.close();assert z.wait()==0
except BaseException:
 z.terminate();raise

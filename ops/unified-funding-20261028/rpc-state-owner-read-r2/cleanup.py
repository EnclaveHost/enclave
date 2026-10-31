from pathlib import Path
import json,subprocess,os,stat
p=Path(__file__).resolve().parent;result={};root=p/'views'
if root.exists():
 st=root.lstat();assert stat.S_ISDIR(st.st_mode) and st.st_uid==os.getuid() and stat.S_IMODE(st.st_mode)==0o700
 for name in ['fixture','l1','base']:
  mount=root/name/'view'
  if not mount.exists():continue
  r=subprocess.run(['/usr/bin/findmnt','-rn','--mountpoint',str(mount),'-o','FSTYPE'],capture_output=True,text=True,timeout=2)
  if r.returncode==1:result[name]='not mounted';continue
  assert r.returncode==0 and r.stdout.strip()=='fuse.nbdfuse',(name,r.stdout)
  subprocess.run(['/usr/sbin/fusermount3','-u',str(mount)],check=True,timeout=3)
  r=subprocess.run(['/usr/bin/findmnt','-rn','--mountpoint',str(mount)],capture_output=True,text=True,timeout=2);assert r.returncode==1
  result[name]='unmounted by unit cleanup'
(p/'CLEANUP.json').write_text(json.dumps(result)+'\n')

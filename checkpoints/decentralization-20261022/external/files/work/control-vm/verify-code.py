from pathlib import Path
import json,hashlib,stat,os
rows=json.loads(Path('/var/lib/enclave-migration/control-code-manifest.json').read_text());bad=[];seen={};n=0
for r in rows:
 p=Path('/')/r['path']
 try:
  s=p.lstat();assert stat.S_IMODE(s.st_mode)==r['mode'],'mode'
  if r['kind']=='symlink':assert p.is_symlink() and os.readlink(p)==r['link'],'symlink'
  elif r['kind']=='directory':assert p.is_dir(),'directory'
  else:
   assert stat.S_ISREG(s.st_mode) and s.st_size==r['size'],'size/type'
   key=(s.st_dev,s.st_ino)
   if key not in seen:seen[key]=hashlib.file_digest(p.open('rb'),'sha256').hexdigest()
   assert seen[key]==r['sha256'],'sha256';n+=1
 except Exception as e:bad.append({'path':r['path'],'problem':str(e)})
print(json.dumps({'entries':len(rows),'verifiedFiles':n,'uniqueInodesHashed':len(seen),'errors':bad[:20],'errorCount':len(bad)}));raise SystemExit(bool(bad))

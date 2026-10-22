from pathlib import Path
import os,stat,hashlib,json,time
roots=['opt/enclave-predict','opt/nan-relay','opt/enclave-dns','opt/enclave-directory-bridge','opt/enclave-gateway','opt/nan-site','opt/enclave-get','opt/enclave-recovery','usr/bin/node','usr/bin/caddy']
rows=[];seen={};total=0;unique=0
for base in roots:
 p=Path('/')/base
 queue=[p]
 while queue:
  p=queue.pop();s=p.lstat();row={'path':str(p.relative_to('/')),'mode':stat.S_IMODE(s.st_mode),'mtime':int(s.st_mtime)}
  if stat.S_ISLNK(s.st_mode):row.update(kind='symlink',link=os.readlink(p))
  elif stat.S_ISDIR(s.st_mode):row['kind']='directory';queue.extend(sorted(p.iterdir(),reverse=True))
  elif stat.S_ISREG(s.st_mode):
   h=hashlib.file_digest(p.open('rb'),'sha256').hexdigest();key=(h,s.st_size,row['mode']);row.update(kind='file',sha256=h,size=s.st_size);total+=s.st_size
   if key in seen:row['duplicate']=seen[key]
   else:seen[key]=row['path'];unique+=s.st_size
  else:raise RuntimeError('Unsupported file type')
  rows.append(row)
out=Path('/var/lib/indexd-migration/control-code-manifest.json');out.write_text(json.dumps(rows));out.chmod(0o600)
print(json.dumps({'entries':len(rows),'logicalBytes':total,'uniqueBytes':unique,'uniqueFiles':len(seen),'manifestSHA256':hashlib.sha256(out.read_bytes()).hexdigest()}))

import pathlib,hashlib,json,os,stat,time
root=pathlib.Path('/home/controladmin/rpc-boot-media-20261031-r1');expected={'source.qcow2':('04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94',621284352),'output/boot.vhdx':('5d01973660220c8069d707e8d54a38d3a68e32956ac8ff9a0075b714974fd175',1933574144)}
intent=root/'duplicate-reclaim.intent'
with intent.open('x') as f:f.write('Retained original Warden source and independently verified Windows target; remove only these two temporary copies. No trim command or other deletion.\n')
checked=[]
for name,(sha,size) in expected.items():
 p=root/name;s=p.lstat()
 if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or s.st_size!=size or p.resolve()!=p:raise RuntimeError('Temporary copy identity')
 with p.open('rb') as f:h=hashlib.file_digest(f,'sha256').hexdigest()
 if h!=sha:raise RuntimeError('Temporary copy digest')
 checked.append((p,s,{'name':name,'sha256':sha,'bytes':size}))
for p,s,record in checked:
 t=p.lstat()
 if (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns)!=(t.st_dev,t.st_ino,t.st_size,t.st_mtime_ns):raise RuntimeError('Temporary copy changed')
 p.unlink()
r={'invocation':os.environ.get('INVOCATION_ID'),'removedDuplicateCopies':[r for p,s,r in checked],'allOtherFilesPreserved':True,'explicitTrimInvoked':False,'targetCopiesRetained':True}
(root/'duplicate-reclaim.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))

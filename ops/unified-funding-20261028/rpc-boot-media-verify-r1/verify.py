import pathlib,json,hashlib,os
p=pathlib.Path('/home/controladmin/rpc-boot-media-20261031-r1/output')
files={}
for name in ['source-info.json','output-info.json','convert.log','compare.log','seed.log','seed-readback.log','RESULT.json']:
 f=p/name
 if f.stat().st_size>65536:raise RuntimeError('Read bound')
 files[name]=f.read_text()
artifacts={}
for name in ['boot.vhdx','seed.iso']:
 f=p/name;before=f.stat()
 with f.open('rb') as stream:h=hashlib.file_digest(stream,'sha256').hexdigest()
 after=f.stat()
 if (before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_ino,after.st_size,after.st_mtime_ns):raise RuntimeError('Changed artifact')
 artifacts[name]={'sha256':h,'bytes':after.st_size}
expected=json.loads(files['RESULT.json'])['files']
if artifacts!=expected:raise RuntimeError('Artifact mismatch')
print(json.dumps({'invocation':os.environ.get('INVOCATION_ID'),'files':files,'artifacts':artifacts,'independentRehashPassed':True,'readOnly':True}))

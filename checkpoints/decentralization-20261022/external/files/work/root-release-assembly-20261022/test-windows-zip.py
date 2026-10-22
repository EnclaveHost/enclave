import tempfile,json,hashlib,zipfile,importlib.util
from pathlib import Path
root=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('a',root/'assemble-r2.py');a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
with tempfile.TemporaryDirectory(dir=root) as td:
 p=Path(td);data=b'actual file';sha=hashlib.sha256(data).hexdigest()
 (p/'manifest.json').write_text(json.dumps({'product':'enclave','control':'test','files':[{'path':'control/file','sha256':sha,'bytes':len(data)}]}));(p/'setup').write_bytes(b'setup')
 for case in ('windows-dir','dir-has-data','duplicate'):
  with zipfile.ZipFile(p/(case+'.zip'),'w') as z:
   z.writestr('control/file',data)
   z.writestr('control\\empty\\', b'bad' if case=='dir-has-data' else b'')
   if case=='duplicate':z.writestr('control\\file',data)
  try:r=a.assemble(p/(case+'.zip'),p/'manifest.json',{}, {'control/file':sha},p/'setup',p/case)
  except SystemExit as e:
   assert case!='windows-dir',str(e)
   assert ('directory entry contains data' if case=='dir-has-data' else 'duplicate normalized member') in str(e)
  else:
   assert case=='windows-dir';assert r['files']==1
print('PASS: Windows empty directory entries; reject nonempty directory entries and normalized file collisions')

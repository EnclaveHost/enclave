from pathlib import Path
import json,hashlib,tarfile,os
p=Path('/home/controladmin/rpc-storage-client-package-20261031-r3');r=json.loads((p/'RESULT.json').read_text());archive=p/'storage-client.tar'
with archive.open('rb') as f:assert hashlib.file_digest(f,'sha256').hexdigest()==r['sha256']=='64222d5433f24a6d32adf0a84031c1d844aaaca534bf162227657475f494ae9c'
assert archive.stat().st_size==r['bytes']==9574400
prefix='opt/enclave-rpc/nbd/';expected={prefix+k:v for k,v in r['files'].items()};links={prefix+'lib/'+name:target for name,target in r['sonames'].items() if name!=target}
with tarfile.open(archive,'r:') as t:
 members=t.getmembers();assert len(members)==len(expected)+len(links) and {m.name for m in members}==set(expected)|set(links)
 for m in members:
  assert m.uid==m.gid==0
  if m.name in links:assert m.issym() and m.linkname==links[m.name]
  else:
   row=expected[m.name];assert m.isfile() and m.mode==0o755 and m.size==row['bytes']
   with t.extractfile(m) as f:assert hashlib.file_digest(f,'sha256').hexdigest()==row['sha256']
print(json.dumps({'archiveSha256':r['sha256'],'bytes':r['bytes'],'verifiedFiles':len(expected),'verifiedAliases':len(links),'noExtraction':True,'invocation':os.environ.get('INVOCATION_ID')}))

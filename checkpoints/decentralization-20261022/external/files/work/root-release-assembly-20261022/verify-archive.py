import hashlib,json,zipfile,sys,datetime
from pathlib import Path
root=Path(__file__).resolve().parent;out=root/'out-2026.10.22.1-r2';v='2026.10.22.1'
def sha(p):
 with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
manifest=out/f'manifest-{v}.json';m=json.loads(manifest.read_text(encoding='utf-8-sig'));assert m['version']==v
rows={e['path']:e for e in m['files']};assert len(rows)==len(m['files'])
inv=json.loads((root.parent/'claude-resumed-20261022/distribution-assembly/inventory.json').read_text())
base=json.loads((root.parent/'g4-release-train-20261021/evidence/manifest-2026.10.12.47.json').read_text(encoding='utf-8-sig'))
expected={e['path']:e['sha256'] for e in base['files']}
for name,row in inv['rows'].items():
 assert row['class'] in ('BASE','OVERLAY')
 if row['class']=='BASE':assert expected[name]==row['sha256']
 else:expected[name]=row['sha256']
assert {name:r['sha256'] for name,r in rows.items()}==expected
zp=out/f'enclave-host-{v}.zip'
with zipfile.ZipFile(zp) as z:
 names=z.namelist();assert len(set(names))==len(names)
 assert set(names)==set(rows)|{'manifest.json'}
 assert z.read('manifest.json')==manifest.read_bytes()
 for name,r in rows.items():
  h=hashlib.sha256();size=0
  with z.open(name) as f:
   for b in iter(lambda:f.read(1<<20),b''):h.update(b);size+=len(b)
  assert h.hexdigest()==r['sha256'] and size==r['bytes'],name
st=json.loads((out/f'release-{v}.statement.json').read_text())
a=json.loads((out/'ASSEMBLY.json').read_text());assert a['signed'] is False and a['files']==len(rows)
artifacts={}
for n,hk,sk in [(st['file'],'sha256','bytes'),(st['setup'],'setupSha256','setupBytes'),(st['manifest'],'manifestSha256','manifestBytes')]:
 p=out/n;actual={'sha256':sha(p),'bytes':p.stat().st_size}
 assert actual=={'sha256':st[hk],'bytes':st[sk]}==a['artifacts'][n]
 artifacts[n]=actual
r={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'archiveVerified':True,'version':v,'files':len(rows),'requiredFiles':len(inv['rows']),'artifacts':artifacts,'signed':False,'published':False,'installed':False,'limitations':['Prototype retains .47 setup; signed bootstrap replacement pending','Platform policy changes and persisted configuration must be incorporated before release','No non-DigitalOcean release copy has been deployed','Owner release public key and signature absent']}
(root/'verification.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r,indent=2))

from pathlib import Path
import json,hashlib,subprocess,os,tarfile
b=Path('work/logo-site-hotfix/current');src=Path('work/logo-site-hotfix/production-current');site=b/'site';sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
old=[];rows=[]
for p in sorted(src.rglob('*')):
 if p.is_file():
  rel=str(p.relative_to(src));old.append({'path':rel,'sha256':sha(p)})
  if rel not in ['js/boot.js','js/boot.js.map']:assert sha(site/rel)==sha(p),rel
for p in sorted(site.rglob('*')):
 assert not p.is_symlink()
 if p.is_file():rows.append({'path':str(p.relative_to(site)),'bytes':p.stat().st_size,'sha256':sha(p)})
cid=(b/'cid.txt').read_text().strip();env=dict(os.environ,IPFS_PATH=str(Path('work/logo-site-hotfix/ipfs').resolve()))
subprocess.run(['ipfs','--offline','get',cid,'-o',str(b/'readback')],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
for x in rows:assert sha(b/'readback'/x['path'])==x['sha256'],x['path']
report={'cid':cid,'carSHA256':sha(b/'site.car'),'files':len(rows),'sourceProduction':'/opt/enclave-site/site-166bf9d33/site','sourceManifest':old,'fileManifest':rows,'reconstructedFromIpfs':True,'oldChunksPreserved':True}
(b/'manifest.json').write_text(json.dumps(report,indent=2)+'\n')
with tarfile.open(b/'package.tar.gz','w:gz',compresslevel=3) as t:
 for name in ['site','site.car','site-root.block','site-root.txt','manifest.json','build.json']:t.add(b/name,arcname=name)
print(json.dumps({k:v for k,v in report.items() if k not in ['fileManifest','sourceManifest']}))

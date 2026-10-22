import pathlib,json,hashlib,os,subprocess
root=pathlib.Path(__file__).resolve().parent
repo=pathlib.Path('work/logo-site-hotfix/ipfs').resolve()
items=[('shield-direct-guest',pathlib.Path('work/shield-direct-build-0ed5a8ba/image/vbs-linux-c7084346/vbs-linux-candidate.bin'),'c7084346a908465404fdf6de332a76b3c2ca844101eb9e8071aa8a1468f197ec'),('shield-direct-build-inputs',pathlib.Path('outputs/shield-direct-build-inputs-c7084346.tar.gz'),'5bb131dea929d6efbe3bcaa2b3113f49b8cfeccc37a65527729091ecb67a1bef')]
def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1<<20),b''):h.update(b)
 return h.hexdigest()
env=dict(os.environ,IPFS_PATH=str(repo),GOMEMLIMIT='128MiB',GOMAXPROCS='1')
rows=[]
for name,p,expected in items:
 assert sha(p)==expected,name
 cid=subprocess.check_output(['/home/steven/.local/bin/ipfs','--offline','add','--cid-version=1','--raw-leaves=true','-Q',str(p.resolve())],env=env,text=True).strip()
 raw=root/(cid+'.bin')
 if not raw.exists():os.link(p,raw)
 car=root/(cid+'.car')
 with car.open('wb') as f:subprocess.run(['/home/steven/.local/bin/ipfs','--offline','dag','export',cid],env=env,stdout=f,check=True)
 rows.append(dict(name=name,cid=cid,sha256=expected,bytes=p.stat().st_size,carSha256=sha(car),carBytes=car.stat().st_size))
 print(json.dumps(rows[-1]),flush=True)
(root/'manifest.json').write_text(json.dumps(dict(verifiedObjects=rows),indent=2)+'\n')

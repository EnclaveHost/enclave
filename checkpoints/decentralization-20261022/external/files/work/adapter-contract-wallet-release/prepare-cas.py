import pathlib,json,urllib.request,hashlib,sys
sys.path.insert(0,str(pathlib.Path('work/enclave/wasm').resolve()))
from ipfs_fetch import verify_car
m=json.load(open('outputs/adapter-contract-wallet-release/upload.json'));cid=m['cid'];expected='132ba32f4580795eab1cbfcaaf20b06af2aa79f2870d3a136b952eb6395510d7';assert m['sha256']==expected
base=pathlib.Path('work/adapter-contract-wallet-cas');base.mkdir(exist_ok=True)
raw=pathlib.Path('work/enclave-apps/s3-ipfs-adapter/target/wasm32-wasip2/release/s3-ipfs-adapter.wasm').read_bytes();assert len(raw)==1578673 and hashlib.sha256(raw).hexdigest()==expected
req=urllib.request.Request('https://7ae476a3.app.enclave.host/ipfs/'+cid,headers={'Accept':'application/vnd.ipld.car','Accept-Encoding':'identity'})
with urllib.request.urlopen(req,timeout=60) as res:
 assert res.status==200;car=res.read(4*1024*1024+1);assert len(car)<=4*1024*1024
assert verify_car(cid,car,len(raw))==raw
for ext,data in [('bin',raw),('car',car)]:
 p=base/(cid+'.'+ext)
 if p.exists():assert p.read_bytes()==data
 else:p.write_bytes(data)
row={'cid':cid,'bytes':len(raw),'sha256':expected,'carSha256':hashlib.sha256(car).hexdigest(),'carBytes':len(car),'source':'adapter-contract-wallet-50f93d74'}
(base/'entry.json').write_text(json.dumps(row,indent=2)+'\n');print(json.dumps(row))

import sys,json,urllib.request,pathlib,hashlib,concurrent.futures
sys.path.insert(0,str(pathlib.Path('work/enclave/wasm').resolve()))
from ipfs_fetch import verify_car
m=json.load(open('outputs/bootstrap-manifest.json'));root=pathlib.Path('work/bootstrap-cas')
def fetch(cid):
 out=root/(cid+'.car');datafile=root/(cid+'.bin')
 if out.exists():
  b=verify_car(cid,out.read_bytes(),128<<20)
 else:
  origin='https://7ae476a3.app.enclave.host' if cid=='bafybeibsra45czyvjs6km7yijtp3t6t623hhl2w2fgzy6lacr6hesawyz4' else 'https://ipfs.enclave.host'
  u=origin+'/ipfs/'+cid+'?format=car&dag-scope=all'
  req=urllib.request.Request(u,headers={'Accept':'application/vnd.ipld.car'})
  with urllib.request.urlopen(req,timeout=90) as r: car=r.read(193<<20)
  if len(car)>192<<20:raise ValueError('bootstrap object too large')
  b=verify_car(cid,car,128<<20);out.write_bytes(car)
 datafile.write_bytes(b)
 result={'cid':cid,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()};print(json.dumps(result),flush=True);return result
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(fetch,m['cids']))
m['verifiedObjects']=results;m['status']='14 active/release CIDs retrieved and CAR-verified locally; independent serving not yet configured'
json.dump(m,open('outputs/bootstrap-manifest.json','w'),indent=2)

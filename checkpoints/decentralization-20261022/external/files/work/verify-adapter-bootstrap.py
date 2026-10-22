import sys,json,urllib.request,pathlib,hashlib,concurrent.futures,datetime
sys.path.insert(0,str(pathlib.Path('work/enclave/wasm').resolve()))
from ipfs_fetch import verify_car
m=json.load(open('outputs/bootstrap-manifest.json'));origin='https://7ae476a3.app.enclave.host'
def get(url):
 with urllib.request.urlopen(urllib.request.Request(url,headers={'Accept':'application/vnd.ipld.car'}),timeout=100) as r:return r.read(193<<20)
inventory=json.loads(get(origin+'/api/files'));json.dump(inventory,open('work/adapter-public-inventory.after.json','w'),indent=2)
expected={x['cid']:x for x in m['verifiedObjects']}
def check(cid):
 b=verify_car(cid,get(origin+'/ipfs/'+cid+'?format=car&dag-scope=all'),128<<20);h=hashlib.sha256(b).hexdigest()
 if h!=expected[cid]['sha256']:raise ValueError('hash mismatch '+cid)
 r={'cid':cid,'bytes':len(b),'sha256':h,'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()};print(json.dumps(r),flush=True);return r
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:r=list(pool.map(check,m['cids']))
json.dump({'origin':origin,'results':r,'allVerified':len(r)==len(m['cids'])},open('work/adapter-bootstrap-readback.json','w'),indent=2)

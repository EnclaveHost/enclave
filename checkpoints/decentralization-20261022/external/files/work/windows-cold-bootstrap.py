import pathlib,hashlib,json,sys
sys.path.insert(0,str(pathlib.Path(__file__).parent))
from ipfs_fetch import fetch_verified
root=pathlib.Path(__file__).parent/'cold-bootstrap';root.mkdir(exist_ok=True)
cid='bafybeia5ep5txxswpmdu5gez4v4albuwzgyhquncgvf6imwicbwpe2od44'
for ip in ['134.199.235.187','134.209.248.172','165.245.191.129','146.190.246.39']:
 b=fetch_verified(cid,['http://127.0.0.1:1','http://'+ip+':8189'],128<<20,15)
 (root/(ip+'-'+cid+'.wasm')).write_bytes(b)
 print(json.dumps({'origin':ip,'cid':cid,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}),flush=True)

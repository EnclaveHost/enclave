import json, pathlib, urllib.request, concurrent.futures, sys, hashlib, datetime, threading, time
sys.path.insert(0,'work/enclave/wasm')
from ipfs_fetch import verify_car
root=pathlib.Path('work/adapter-retained'); checkpoint=root/'verified.json'
results=json.loads(checkpoint.read_text()); rows={x['cid']:x for x in json.load(open('work/adapter-public-inventory.after.json'))}
lock=threading.Lock(); errors=[]
def recover(row):
 cid=row['cid']; size=int(row['size']); url='https://7ae476a3.app.enclave.host/ipfs/'+cid+'?format=car&dag-scope=all'
 for attempt in range(2):
  try:
   with urllib.request.urlopen(urllib.request.Request(url,headers={'Accept':'application/vnd.ipld.car'}),timeout=25) as r: car=r.read(size+(1<<20))
   data=verify_car(cid,car,max(size,1))
   if len(data)!=size:raise ValueError('inventory length mismatch')
   break
  except Exception:
   if attempt:raise
   time.sleep(2)
 (root/(cid+'.car')).write_bytes(car); (root/(cid+'.bin')).write_bytes(data)
 entry={'cid':cid,'bytes':size,'sha256':hashlib.sha256(data).hexdigest(),'carSha256':hashlib.sha256(car).hexdigest(),'source':'https://7ae476a3.app.enclave.host','verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 with lock:
  results[cid]=entry;tmp=checkpoint.with_suffix('.tmp');tmp.write_text(json.dumps(results,indent=2));tmp.replace(checkpoint)
  print(json.dumps({'verified':len(results),'cid':cid,'bytes':size}),flush=True)
selected=sorted((r for c,r in rows.items() if c not in results and int(r['size'])<=1<<20),key=lambda r:int(r['size']))
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as p:
 futures={p.submit(recover,r):r for r in selected}
 for f in concurrent.futures.as_completed(futures):
  try:f.result()
  except Exception as e:
   err={'cid':futures[f]['cid'],'error':str(e)};errors.append(err);print(json.dumps(err),flush=True)
json.dump({'attempted':len(selected),'verifiedTotal':len(results),'errors':errors},open('work/small-recovery-result.json','w'),indent=2)

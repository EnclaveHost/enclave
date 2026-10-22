import json, pathlib, urllib.request, concurrent.futures, sys, hashlib, datetime, threading, time, http.client
sys.path.insert(0,'work/enclave/wasm')
from ipfs_fetch import verify_car
class GuestTLSConnection(http.client.HTTPSConnection):
 def connect(self):
  if self.host!='7ae476a3.app.enclave.host' or self.port!=443:raise ValueError('unexpected TLS destination')
  self.sock=self._create_connection(('127.0.0.1',18443),self.timeout,self.source_address)
  self.sock=self._context.wrap_socket(self.sock,server_hostname=self.host)
class GuestTLSHandler(urllib.request.HTTPSHandler):
 def https_open(self,req):return self.do_open(GuestTLSConnection,req,context=self._context)
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({}),GuestTLSHandler()))
root=pathlib.Path('work/adapter-retained'); checkpoint=root/'verified.json' 
results=json.loads(checkpoint.read_text()); rows={x['cid']:x for x in json.load(open('work/adapter-public-inventory.after.json'))}
lock=threading.Lock(); errors=[]
def recover(row):
 cid=row['cid']; size=int(row['size']); url='https://7ae476a3.app.enclave.host/ipfs/'+cid+'?format=car&dag-scope=all'
 for attempt in range(2):
  try:
   with urllib.request.urlopen(urllib.request.Request(url,headers={'Accept':'application/vnd.ipld.car'}),timeout=45) as r: car=r.read(size+max(size//20,1<<20)+1)
   data=verify_car(cid,car,max(size,1))
   if len(data)!=size:raise ValueError('inventory length mismatch')
   break
  except Exception:
   if attempt:raise
   time.sleep(2)
 (root/(cid+'.car')).write_bytes(car); (root/(cid+'.bin')).write_bytes(data)
 entry={'cid':cid,'bytes':size,'sha256':hashlib.sha256(data).hexdigest(),'carSha256':hashlib.sha256(car).hexdigest(),'source':'https://7ae476a3.app.enclave.host (guest TLS over SSH local ingress; recovery only)','verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 with lock:
  results[cid]=entry;tmp=checkpoint.with_suffix('.tmp');tmp.write_text(json.dumps(results,indent=2));tmp.replace(checkpoint)
  print(json.dumps({'verified':len(results),'cid':cid,'bytes':size}),flush=True)
selected=sorted((r for c,r in rows.items() if c not in results and int(r['size'])<=128<<20),key=lambda r:int(r['size']))
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as p:
 futures={p.submit(recover,r):r for r in selected}
 for f in concurrent.futures.as_completed(futures):
  try:f.result()
  except Exception as e:
   err={'cid':futures[f]['cid'],'error':str(e)};errors.append(err);print(json.dumps(err),flush=True)
json.dump({'attempted':len(selected),'verifiedTotal':len(results),'errors':errors},open('work/local-recovery-result.json','w'),indent=2)

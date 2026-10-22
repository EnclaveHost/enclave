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
import importlib.util
spec=importlib.util.spec_from_file_location('ranged_copy','work/adapter-ranged-copy.py');ranged_copy=importlib.util.module_from_spec(spec);spec.loader.exec_module(ranged_copy)
root=pathlib.Path('work/adapter-retained');checkpoint=root/'verified.json';results=json.loads(checkpoint.read_text());rows={x['cid']:x for x in json.load(open('work/adapter-public-inventory.after.json'))}
for cid,row in rows.items():
 if cid in results:continue
 size=int(row['size']);car=ranged_copy.ranged(cid,size,root/(cid+'.bin'));data=verify_car(cid,car,size)
 if len(data)!=size:raise ValueError('size mismatch')
 results[cid]={'cid':cid,'bytes':size,'sha256':hashlib.sha256(data).hexdigest(),'carSha256':hashlib.sha256(car).hexdigest(),'source':'https://7ae476a3.app.enclave.host (ranged guest TLS over SSH local ingress; recovery only)','verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 temp=checkpoint.with_suffix('.tmp');temp.write_text(json.dumps(results,indent=2));temp.replace(checkpoint);print(json.dumps({'verified':len(results),'cid':cid,'bytes':size}),flush=True)

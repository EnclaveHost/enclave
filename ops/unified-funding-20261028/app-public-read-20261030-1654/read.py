import urllib.request,urllib.error,json,time,hashlib
from pathlib import Path
p=Path(__file__).resolve().parent
rows=[]
for host in ('59f1273d.app.enclave.host','9a28642b.app.enclave.host'):
 row={'host':host,'at':time.time(),'method':'GET','readOnly':True}
 try:
  try:r=urllib.request.urlopen(urllib.request.Request('https://'+host+'/',headers={'User-Agent':'Enclave-readiness-check/1'}),timeout=12)
  except urllib.error.HTTPError as e:r=e
  with r:
   body=r.read(16385);row.update(status=r.status,finalUrl=r.url,bytesSampled=len(body),truncated=len(body)>16384,sha256=hashlib.sha256(body).hexdigest(),contentType=r.headers.get('Content-Type'))
 except Exception as e:row.update(error=type(e).__name__,detail=str(e)[:180])
 rows.append(row)
(p/'RESULT.json').write_text(json.dumps(rows,indent=2));print(json.dumps(rows))

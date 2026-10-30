from pathlib import Path
import json,time,urllib.request,urllib.error,ssl
p=Path(__file__).resolve().parent
with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'readOnly':True,'noRetry':True},f)
rows=[]
for host in ('59f1273d.app.enclave.host','9a28642b.app.enclave.host'):
 start=time.monotonic()
 try:
  request=urllib.request.Request('https://'+host+'/',method='HEAD',headers={'User-Agent':'Enclave-restoration-read/1'})
  with urllib.request.urlopen(request,timeout=8,context=ssl.create_default_context()) as r:
   rows.append({'host':host,'status':r.status,'url':r.url,'elapsed':time.monotonic()-start})
 except Exception as e:rows.append({'host':host,'error':type(e).__name__,'detail':str(e)[:220],'elapsed':time.monotonic()-start})
with (p/'RESULT.json').open('x') as f:json.dump({'at':time.time(),'observations':rows,'runningProof':False,'financialActions':False},f,indent=2)
print(json.dumps(rows))

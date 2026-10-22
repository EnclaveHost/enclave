#!/usr/bin/env python3
"""Read-only public HTTP/TLS checks after the network runtime activation."""
import datetime,json,sys,time,urllib.request
from pathlib import Path
out=Path(sys.argv[1]); rows=[]
for label,url in [('enclavedns','https://59f1273d.app.enclave.host/'),('cron','https://38f368d6.app.enclave.host/ping'),('storage-adapter','https://7ae476a3.app.enclave.host/'),('eyesoff-ai','https://9eb4e600.app.enclave.host/')]:
 start=time.monotonic();r={'app':label,'url':url}
 try:
  with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'Enclave-operational-readonly-check'}),timeout=25) as res:
   r.update(status=res.status,tlsVerified=True,finalUrl=res.url)
 except Exception as e:r.update(error=str(e),tlsVerified=False)
 r['seconds']=round(time.monotonic()-start,3);rows.append(r)
result={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'checks':rows,'pass':all(x.get('status')==200 and x.get('tlsVerified') for x in rows),'scope':'Public reachability and valid TLS only; not provider independence or complete app functionality.'}
with out.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
print(json.dumps(result,indent=2));sys.exit(0 if result['pass'] else 3)

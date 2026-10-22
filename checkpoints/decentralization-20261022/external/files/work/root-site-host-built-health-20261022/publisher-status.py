from pathlib import Path
import urllib.request,json,datetime
url='https://d9798e4c.app.enclave.host/api/status'
with urllib.request.urlopen(url,timeout=15) as r:
 b=r.read(65537)
 if len(b)>65536:raise ValueError('oversize status')
 j=json.loads(b)
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'url':url,'status':r.status,'publicStatus':{k:j[k] for k in ['peerId','name','sequence','value','validUntil','publishedAt','recovered','mode','queuedTasks','uptimeSecs'] if k in j}}
Path(__file__).with_suffix('.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps(out))

import concurrent.futures, urllib.request, urllib.error, json, datetime, time
from pathlib import Path
urls=['https://7ae476a3.app.enclave.host/health','https://7ae476a3.app.enclave.host/']
def get(u):
 t=time.monotonic(); d={'url':u}
 try:
  with urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'Enclave-availability-diagnostic/1.0'}),timeout=25) as r:
   d.update(status=r.status,final=r.url,headers=dict(r.headers),sample=r.read(2048).decode(errors='replace'))
 except urllib.error.HTTPError as e:d.update(status=e.code,headers=dict(e.headers),sample=e.read(2048).decode(errors='replace'))
 except Exception as e:d['error']=str(e)
 d['seconds']=round(time.monotonic()-t,2);return d
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool: out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'checks':list(pool.map(get,urls))}
p=Path(__file__).with_name('adapter-after-job-fix-http.json');p.write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2))

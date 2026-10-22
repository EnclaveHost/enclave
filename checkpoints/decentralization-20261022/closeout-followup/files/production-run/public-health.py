import concurrent.futures, datetime, json, pathlib, urllib.request, urllib.error, time
urls=['https://enclave.host/','https://59f1273d.app.enclave.host/','https://7ae476a3.app.enclave.host/','https://ef514ed3.app.enclave.host/','https://9eb4e600.app.enclave.host/']
def check(url):
 t=time.monotonic()
 try:
  with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'Enclave-health-readonly/1'}),timeout=20) as r:
   data={'url':url,'status':r.status,'contentType':r.headers.get('Content-Type'),'tlsVerified':True};r.read(256)
 except urllib.error.HTTPError as e:data={'url':url,'status':e.code,'tlsVerified':True}
 except Exception as e:data={'url':url,'error':str(e),'tlsVerified':False}
 data['elapsedSeconds']=round(time.monotonic()-t,2);return data
with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool: results=list(pool.map(check,urls))
r={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'method':'Unauthenticated HTTPS GET; default certificate verification; at most 256 response bytes read, none retained','results':results,'limits':'This checks public routing/TLS only. It does not prove authenticated app functionality or the .eth path.'}
p=pathlib.Path('outputs/decentralization-audit/public-health-during-storage-migration-20261022.json');p.write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r,indent=2))

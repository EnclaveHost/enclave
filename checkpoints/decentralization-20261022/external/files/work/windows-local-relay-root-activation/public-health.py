import concurrent.futures,urllib.request,json,re,datetime
from pathlib import Path
urls=['https://enclave.host/dashboard','https://9eb4e600.app.enclave.host/ping','https://da09d0f2.app.enclave.host/','https://7ae476a3.app.enclave.host/healthz']
def check(u):
 try:
  with urllib.request.urlopen(u,timeout=20) as r:st=r.status;b=r.read(1<<20);content=r.headers.get('Content-Type','')
  title=re.search(br'<title[^>]*>(.*?)</title>',b,re.I|re.S)
  d={'url':u,'status':st,'contentType':content,'title':title.group(1).decode(errors='replace') if title else None}
  if u.endswith('/ping'):
   j=json.loads(b);d['ping']={k:j.get(k) for k in ['ok','pong']};d['ok']=st==200 and j.get('ok') is True and j.get('pong') is True
  else:d['ok']=st==200 and not(d['title'] and 'Page Not Found' in d['title'])
  return d
 except Exception as e:return {'url':u,'ok':False,'error':str(e)[:180]}
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:results=list(pool.map(check,urls))
d={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'public HTTP and EyesOff ping; not full browser/render verification','results':results,'allOk':all(x['ok'] for x in results)}
Path('outputs/decentralization-audit/public-health-after-local-relay.json').write_text(json.dumps(d,indent=2)+'\n');print(json.dumps(d,indent=2));raise SystemExit(0 if d['allOk'] else 1)

import urllib.request,urllib.error,json,pathlib,datetime,concurrent.futures
base='https://59f1273d.app.enclave.host'
urls=[base+'/healthz',base+'/resolve?name=example.com&type=A',base+'/dns-query?name=example.com&type=A']
def fetch(url):
 try:
  req=urllib.request.Request(url,headers={'Accept':'application/dns-json' if '/dns-query' in url else 'application/json'})
  with urllib.request.urlopen(req,timeout=30)as r:return {'url':url,'status':r.status,'body':r.read(12000).decode(errors='replace')}
 except urllib.error.HTTPError as e:return {'url':url,'status':e.code,'body':e.read(2000).decode(errors='replace')}
 except Exception as e:return {'url':url,'error':str(e)}
with concurrent.futures.ThreadPoolExecutor(max_workers=3)as ex:results=list(ex.map(fetch,urls))
o={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'results':results};pathlib.Path(__file__).with_name('root-health.json').write_text(json.dumps(o,indent=2)+'\n');print(json.dumps(o))

from pathlib import Path
import urllib.request,urllib.error,urllib.parse,concurrent.futures,html.parser,json,datetime,time,hashlib
class Links(html.parser.HTMLParser):
 def __init__(self):super().__init__();self.paths=[]
 def handle_starttag(self,t,attrs):
  a=dict(attrs)
  if t=='script' and a.get('src'):self.paths.append(a['src'])
  if t=='link' and a.get('rel')=='stylesheet' and a.get('href'):self.paths.append(a['href'])
def get(url):
 start=time.monotonic();body=b'';d={'url':url}
 try:
  with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'Enclave-availability-check/1.0'}),timeout=20) as r:
   body=r.read(1048576);d.update(status=r.status,finalUrl=r.url,contentType=r.headers.get('Content-Type'),root=r.headers.get('X-Ipfs-Roots'),bytesRead=len(body),sha256=hashlib.sha256(body).hexdigest())
 except urllib.error.HTTPError as e:d['status']=e.code
 except Exception as e:d['error']=str(e)[:200]
 d['seconds']=round(time.monotonic()-start,2);return d,body
rows=[]
for home in ['https://enclavehost.eth.limo/','https://enclavehost.eth.link/']:
 d,b=get(home);rows.append(d)
 if d.get('status')==200:
  p=Links();p.feed(b.decode(errors='replace'));urls=[]
  for path in p.paths[:4]:
   u=urllib.parse.urljoin(home,path)
   if urllib.parse.urlparse(u).netloc==urllib.parse.urlparse(home).netloc:urls.append(u)
  with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:rows.extend(x[0] for x in ex.map(get,urls))
d,b=get('https://d9798e4c.app.enclave.host/api/status');rows.append(d)
if d.get('status')==200:
 try:
  x=json.loads(b);d['publicJsonKeys']=list(x) if isinstance(x,dict) else None
 except:pass
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'checks':rows,'scope':'Public root documents and referenced script/style responses only; not a full cold bootstrap or authenticated feature proof.'}
Path(__file__).with_name('asset-check.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2))

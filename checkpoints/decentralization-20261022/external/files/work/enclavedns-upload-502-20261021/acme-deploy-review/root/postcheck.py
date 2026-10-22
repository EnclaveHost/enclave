import urllib.request,json,concurrent.futures,pathlib,datetime,time
urls=[('relay','https://api.enclave.host/health','GET'),('caNonce','https://acme.zerossl.com/v2/DV90/newNonce','HEAD')]
def get(a):
 k,u,m=a;t=time.monotonic()
 try:
  with urllib.request.urlopen(urllib.request.Request(u,method=m),timeout=15) as r:
   o={'check':k,'httpStatus':r.status,'replayNoncePresent':bool(r.headers.get('Replay-Nonce')) if k=='caNonce' else None}
 except Exception as e:o={'check':k,'errorType':type(e).__name__}
 o['elapsedSec']=round(time.monotonic()-t,2);return o
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'checks':list(ex.map(get,urls))}
p=pathlib.Path(__file__).with_name('postcheck.json');p.write_text(json.dumps(out,indent=2));print(json.dumps(out))

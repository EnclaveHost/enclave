import urllib.request,hashlib,json,datetime,pathlib
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'readOnly':True,'responses':[]}
for url in ['https://enclave.host/.well-known/enclave-site-release.json','https://enclave.host/']:
 try:
  with urllib.request.urlopen(url,timeout=15) as r:
   b=r.read(2<<20);v={'url':url,'status':r.status,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'headers':{k:r.headers.get(k) for k in ['etag','x-ipfs-path','x-ipfs-roots','x-enclave-release','content-type']}}
   if url.endswith('.json'):
    try:v['releaseMetadata']=json.loads(b)
    except ValueError:v['error']='not JSON'
   out['responses'].append(v)
 except Exception as e:out['responses'].append({'url':url,'error':str(e)[:300]})
p=pathlib.Path('work/custody-v2-live-20261023/evidence/public-site-base.json');p.write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))

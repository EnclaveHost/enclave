import urllib.request,json,datetime,pathlib
url='https://api.enclave.host/t/custody-metal0/v2/custody/info'
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'url':url,'readOnly':True}
try:
 with urllib.request.urlopen(url,timeout=12) as r:
  raw=r.read(262145)
  if len(raw)>262144:raise ValueError('response exceeds 256 KiB')
  data=json.loads(raw)
  out.update(status=r.status,fields=sorted(data.keys()),publicInfo={k:data[k] for k in ['identity','encKey','endpoint','vault','committeeId','epoch','measurement','chipId','registryId','version'] if k in data})
except Exception as e:out.update(error=str(e),status=getattr(e,'code',None))
pathlib.Path('work/custody-v2-live-20261023/evidence/public-info.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))

import urllib.request,json,pathlib,datetime
u='https://api.enclave.host/v1/network/routes'
with urllib.request.urlopen(u,timeout=20) as r: b=r.read(2*1024*1024+1)
assert len(b)<=2*1024*1024
j=json.loads(b)
def keep(v):
 if isinstance(v,dict):
  if any(isinstance(x,str) and ('38f368d6' in x or 'ef514ed3' in x) for x in v.values()): return v
  return {k:z for k,x in v.items() if (z:=keep(x)) not in ({},[],None)}
 if isinstance(v,list): return [z for x in v if (z:=keep(x)) not in ({},[],None)]
 return None
d={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'keys':list(j) if isinstance(j,dict) else None,'selected':keep(j)}
pathlib.Path(__file__).with_suffix('.json').write_text(json.dumps(d,indent=2)+'\n');print(json.dumps(d,indent=2))

import json,urllib.request,urllib.parse,collections,sys
sys.path.insert(0,'/var/lib/indexd-migration');from ipfs_fetch import _fields,_parse_dagpb
pins=json.load(sys.stdin);out=[]
for cid in pins:
 kind=0
 if not cid.startswith('bafkrei'):
  q=urllib.request.Request('http://127.0.0.1:5001/api/v0/block/get?arg='+urllib.parse.quote(cid),data=b'')
  with urllib.request.urlopen(q,timeout=15) as r:body=r.read(2<<20)
  links,data=_parse_dagpb(body);kind=next((v for f,w,v in _fields(data) if f==1 and w==0),None)
 out.append({'cid':cid,'unixfsType':kind})
print(json.dumps(out))

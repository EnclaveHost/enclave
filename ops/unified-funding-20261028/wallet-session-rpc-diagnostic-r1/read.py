import urllib.request,json,concurrent.futures
from pathlib import Path
p=Path(__file__).resolve().parent
urls=['https://api.enclave.host/rpc/base','https://base-mainnet.public.blastapi.io','https://base-rpc.publicnode.com']
queries=[('genesis','eth_getCode',['0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b','0x0']),('log-range','eth_getLogs',[{'address':'0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b','fromBlock':hex(52831588),'toBlock':hex(52851587)}])]
def read(args):
 url,q=args;name,method,params=q
 try:
  req=urllib.request.Request(url,data=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}).encode(),headers={'Content-Type':'application/json'})
  with urllib.request.urlopen(req,timeout=12) as r:b=r.read(100000)
  j=json.loads(b);res=j.get('result');return {'url':url,'probe':name,'error':j.get('error'),'success': 'result' in j,'count':len(res) if isinstance(res,list) else None,'emptyCode':res=='0x'}
 except Exception as e:return {'url':url,'probe':name,'error':str(e)}
with (p/'attempt').open('x') as f:f.write('six bounded readonly diagnostic calls, no retry\n')
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as x:r=list(x.map(read,[(u,q) for u in urls for q in queries]))
(p/'result.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))

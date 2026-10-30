import json,urllib.request,pathlib,time
p=pathlib.Path(__file__).resolve().parent
with (p/'attempt').open('x') as f:f.write('read only')
queries=[['eth_chainId', []], ['eth_getLogs', [{'address': '0xb794c4dd0e1c5e6b72281799f282bfde7654345d', 'topics': ['0x237474e4be335a39597b4f51c417a830f3e5c5ed9d647e1fb8b4195d2a16dbcb'], 'fromBlock': '0x31dd4ad', 'toBlock': '0x31dd4ad'}]]]
out=[]
for method,params in queries:
 try:
  body=json.dumps({'jsonrpc':'2.0','id':len(out)+1,'method':method,'params':params}).encode()
  r=urllib.request.urlopen(urllib.request.Request('https://rpc.baseazul.dev',data=body,headers={'Content-Type':'application/json'}),timeout=15)
  b=r.read(1048577);assert len(b)<=1048576
  out.append({'method':method,'response':json.loads(b)})
 except Exception as e:out.append({'method':method,'error':str(e)})
(p/'result.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))

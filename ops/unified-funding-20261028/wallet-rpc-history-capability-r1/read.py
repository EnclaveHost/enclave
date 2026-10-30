import json,urllib.request,pathlib,concurrent.futures
p=pathlib.Path(__file__).resolve().parent
with (p/'attempt').open('x') as f:f.write('public read only capability batch, no retries')
urls=['https://rpcfree.com/base-rpc', 'https://rpc.baseazul.dev', 'https://rpc.satelink.network/rpc/base', 'https://xrpc.cl/base', 'https://base-rpc.blockreq.com/v1/rpc/public', 'https://base.daybreak-rpc.network', 'https://api.blockvectra.com/v1/base_mainnet/public']
queries=[['eth_chainId', []], ['eth_getLogs', [{'address': '0xb794c4dd0e1c5e6b72281799f282bfde7654345d', 'topics': ['0x237474e4be335a39597b4f51c417a830f3e5c5ed9d647e1fb8b4195d2a16dbcb'], 'fromBlock': '0x31dd4ad', 'toBlock': '0x32cc5a2'}]]]
def probe(url):
 out=[]
 for method,params in queries:
  try:
   body=json.dumps({'jsonrpc':'2.0','id':len(out)+1,'method':method,'params':params}).encode()
   r=urllib.request.urlopen(urllib.request.Request(url,data=body,headers={'Content-Type':'application/json'}),timeout=15)
   b=r.read(1048577);assert len(b)<=1048576
   out.append({'method':method,'response':json.loads(b)})
  except Exception as e:out.append({'method':method,'error':str(e)})
 return {'origin':url,'responses':out}
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex: out=list(ex.map(probe,urls))
(p/'result.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps([{'origin':r['origin'],'responses':[{'method':v['method'],'error':v.get('error') or v.get('response',{}).get('error'),'resultCount':len(v['response']['result']) if isinstance(v.get('response',{}).get('result'),list) else v.get('response',{}).get('result')} for v in r['responses']]} for r in out]))

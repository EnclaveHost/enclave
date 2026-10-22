import concurrent.futures,datetime,json,urllib.request
from pathlib import Path
URLS=['https://mainnet.base.org','https://base.public.blockpi.network/v1/rpc/public']
VAULT='0xe48699b8401564aace7a814ae4569b67a3f7eef5';start=52849852
out={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'fromBlock':start,'vault':VAULT,'complete':False,'providers':[]}
def rpc(u,m,p):
 req=urllib.request.Request(u,data=json.dumps({'jsonrpc':'2.0','id':1,'method':m,'params':p}).encode(),headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=12) as r:
  b=r.read(2097153)
  if len(b)>2097152:raise RuntimeError('oversized response')
  d=json.loads(b)
  if 'error' in d:raise RuntimeError(str(d['error'])[:180])
  return d['result']
def across(m,p):
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:return list(pool.map(lambda u:rpc(u,m,p),URLS))
try:
 chains=across('eth_chainId',[])
 if chains!=['0x2105']*2:raise RuntimeError('chain disagreement')
 heads=across('eth_blockNumber',[]);end=min(int(h,16) for h in heads)-12
 if end-start>30000:raise RuntimeError('delta exceeds bounded scan limit')
 blocks=across('eth_getBlockByNumber',[hex(end),False])
 if not blocks[0] or any(b['hash']!=blocks[0]['hash'] for b in blocks):raise RuntimeError('block disagreement')
 out.update(toBlock=end,blockHash=blocks[0]['hash']);all_logs=[]
 for lo in range(start,end+1,5000):
  rs=across('eth_getLogs',[{'address':VAULT,'fromBlock':hex(lo),'toBlock':hex(min(lo+4999,end))}])
  def public(logs):return sorted([{'blockNumber':x['blockNumber'],'blockHash':x['blockHash'],'transactionHash':x['transactionHash'],'logIndex':x['logIndex'],'topics':x['topics']} for x in logs],key=lambda x:(int(x['blockNumber'],16),int(x['logIndex'],16)))
  a,b=map(public,rs)
  if a!=b:raise RuntimeError('event disagreement')
  all_logs.extend(a)
 out.update(complete=True,eventCount=len(all_logs),events=all_logs,providers=URLS)
except Exception as e:out['error']=str(e)[:220]
Path('outputs/custody-existing-contracts/recent-event-audit.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2))

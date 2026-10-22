from pathlib import Path
import urllib.request,json,concurrent.futures,time,datetime
DEADLINE=1792564823
RPCS=['https://base-rpc.publicnode.com','https://mainnet.base.org','https://base-mainnet.public.blastapi.io']
def rpc(url,method,params):
 req=urllib.request.Request(url,data=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}).encode(),headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=12) as r: o=json.load(r)
 if 'error' in o: raise RuntimeError('RPC refused')
 return o['result']
def peer(url):
 try:
  assert int(rpc(url,'eth_chainId',[]),16)==8453
  b=rpc(url,'eth_getBlockByNumber',['latest',False]);return {'url':url,'number':int(b['number'],16)}
 except Exception as e:return {'url':url,'error':type(e).__name__,'reason':str(e)[:200]}
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:heads=list(ex.map(peer,RPCS))
print(json.dumps({'heads':heads}),flush=True)
ok=[x for x in heads if 'number'in x];assert len(ok)>=2,'insufficient Base peers'
height=sorted((x['number'] for x in ok),reverse=True)[1]-2
rows=[]
for p in ok:
 try:
  b=rpc(p['url'],'eth_getBlockByNumber',[hex(height),False]);ts=int(b['timestamp'],16)
  assert int(b['number'],16)==height and DEADLINE<ts<=time.time()+5 and time.time()-ts<120
  rows.append({'rpc':p['url'],'number':height,'hash':b['hash'],'timestamp':ts})
 except Exception as e:rows.append({'rpc':p['url'],'error':type(e).__name__})
groups={}
for p in rows:
 if 'hash' in p:groups.setdefault((p['hash'],p['timestamp']),[]).append(p)
winning=next((v for v in groups.values() if len(v)>=2),None);assert winning,'No fresh matching two-provider header after signed release expiry'
o={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'signedReleaseDeadline':DEADLINE,'agreedBlock':winning[0],'agreeingPeers':len(winning),'signaturesExpired':True,'rows':rows}
Path('outputs/decentralization-audit/linux-rollback-release-expiry.json').write_text(json.dumps(o,indent=2)+'\n');print(json.dumps(o))

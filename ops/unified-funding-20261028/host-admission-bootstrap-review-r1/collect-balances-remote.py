# Read-only public-address observation. No process environment, keys or wallet imports.
import urllib.request,json,time,signal,datetime,re
WALLET='0x3d447593739c3f2baf1a7579cd874baa3e0971aa'
USDC='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
URLS=['https://mainnet.base.org','https://base-mainnet.public.blastapi.io']
ALLOWED={'eth_chainId','eth_getBlockByNumber','eth_getBalance','eth_getTransactionCount','eth_call','eth_getCode'}
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):raise ValueError('redirect refused')
opener=urllib.request.build_opener(NoRedirect)
last={};seq=0
signal.signal(signal.SIGALRM,lambda *_: (_ for _ in ()).throw(TimeoutError('overall observation deadline')))
signal.alarm(100)
def rpc(url,method,params):
 global seq
 assert url in URLS and method in ALLOWED
 if method=='eth_call':assert params[0]=={'to':USDC,'data':'0x70a08231'+WALLET[2:].zfill(64)}
 time.sleep(max(0,last.get(url,0)+2.5-time.monotonic()));last[url]=time.monotonic();seq+=1
 req=urllib.request.Request(url,data=json.dumps({'jsonrpc':'2.0','id':seq,'method':method,'params':params}).encode(),headers={'Content-Type':'application/json'},method='POST')
 with opener.open(req,timeout=8) as resp:
  raw=resp.read(262145)
  if len(raw)>262144:raise ValueError('response too large')
 j=json.loads(raw)
 if j.get('jsonrpc')!='2.0' or j.get('id')!=seq or 'error' in j or 'result' not in j:raise ValueError('RPC identity/result rejected')
 return j['result']
def quantity(x):
 if not isinstance(x,str) or not re.fullmatch('0x[0-9a-fA-F]+',x):raise ValueError('invalid hex quantity')
 return int(x,16)
r={'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'readOnly':True,'wallet':WALLET,'usdc':USDC,'providers':[],'agreement':False,'spendAuthorizedByObservation':False,'note':'Public RPC agreement is not independent chain proof, signer identity, finality or queue quiescence. Persisted orders are a separate observation; no liability-completeness claim.'}
try:
 heads=[]
 for u in URLS:
  if quantity(rpc(u,'eth_chainId',[]))!=8453:raise ValueError('wrong chain')
  heads.append(quantity(rpc(u,'eth_getBlockByNumber',['latest',False])['number']))
 n=min(heads)-2
 for u in URLS:
  h=rpc(u,'eth_getBlockByNumber',[hex(n),False])
  if quantity(h['number'])!=n or not re.fullmatch('0x[0-9a-fA-F]{64}',h['hash']):raise ValueError('header identity mismatch')
  at={'blockHash':h['hash'],'requireCanonical':True}
  row={'provider':u,'number':str(n),'hash':h['hash'],'timestamp':str(quantity(h['timestamp']))}
  row['ethWei']=str(quantity(rpc(u,'eth_getBalance',[WALLET,at])))
  row['usdc6']=str(quantity(rpc(u,'eth_call',[{'to':USDC,'data':'0x70a08231'+WALLET[2:].zfill(64)},at])))
  row['nonceAtBlock']=str(quantity(rpc(u,'eth_getTransactionCount',[WALLET,at])))
  row['noncePendingObservation']=str(quantity(rpc(u,'eth_getTransactionCount',[WALLET,'pending'])))
  code=rpc(u,'eth_getCode',[WALLET,at]);row['hasCode']=code not in ('0x','0x0')
  fresh=rpc(u,'eth_getBlockByNumber',[hex(n),False])
  if fresh['hash']!=h['hash'] or fresh['number']!=h['number']:raise ValueError('header changed during observation')
  r['providers'].append(row)
 if len(r['providers'])==2:
  a,b=r['providers'];keys=['number','hash','timestamp','ethWei','usdc6','nonceAtBlock','hasCode']
  r['agreement']=all(a[k]==b[k] for k in keys)
  if not r['agreement']:raise ValueError('providers disagree')
except Exception as e:r['error']=type(e).__name__+': '+str(e)[:200]
finally:signal.alarm(0)
print(json.dumps(r))

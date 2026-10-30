import json,urllib.request,pathlib,concurrent.futures,time,threading
p=pathlib.Path(__file__).resolve().parent
with (p/'attempt').open('x') as f:f.write('one independent complete history crosscheck; no transactions or retries')
h=json.loads((p/'api-history.json').read_text());end=int(h['block']);deadline=time.monotonic()+600;lock=threading.Lock();last=[0.0];count=[0]
def rpc(m,params):
 with lock:
  delay=max(0,last[0]+0.2-time.monotonic());time.sleep(delay);last[0]=time.monotonic();count[0]+=1;assert count[0]<=1100
 assert time.monotonic()<deadline
 body=json.dumps({'jsonrpc':'2.0','id':count[0],'method':m,'params':params}).encode()
 r=urllib.request.urlopen(urllib.request.Request('https://base.daybreak-rpc.network',data=body,headers={'Content-Type':'application/json'}),timeout=15)
 raw=r.read(1048577);assert len(raw)<=1048576
 v=json.loads(raw);assert 'result' in v,str(v.get('error'))[:200]
 return v['result']
def norm(x):
 keys=['address','data','blockHash','transactionHash'];z={k:x[k].lower() for k in keys};z['topics']=[t.lower() for t in x['topics']]
 for k in ['blockNumber','transactionIndex','logIndex']:z[k]=int(x[k],16) if isinstance(x[k],str) and x[k].startswith('0x') else int(x[k])
 assert not x.get('removed');return z
out={'readOnly':True,'independentOrigin':'https://base.daybreak-rpc.network','anchor':end,'complete':False,'ranges':[]}
try:
 assert rpc('eth_chainId',[])=='0x2105'
 block=rpc('eth_getBlockByNumber',[hex(end),False]);out['blockHash']=block['hash']
 streams=[('delegates','0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b',52515705,h['value']['delegateHistory']['logs']),('sessions','0xb794c4dd0e1c5e6b72281799f282bfde7654345d',52286637,h['value']['vaults'][0]['sessionHistory']['logs'])]
 def scan(job):
  name,address,lo,hi,topics=job;raw=rpc('eth_getLogs',[{'address':address,'topics':topics,'fromBlock':hex(lo),'toBlock':hex(hi)}]);assert isinstance(raw,list) and len(raw)<2048
  logs=[norm(x)for x in raw]
  for x in logs:assert x['address']==address and lo<=x['blockNumber']<=hi and x['topics'][0]==topics[0]
  return {'stream':name,'from':lo,'to':hi,'logs':logs}
 jobs=[]
 for name,address,start,expected in streams:
  topics=[expected[0]['topics'][0]]
  if name=='delegates':topics.append(['0x'+'0b2d009c0c9af05b12100d77f3c815fea822ee61'.rjust(64,'0'),'0x'+'b794c4dd0e1c5e6b72281799f282bfde7654345d'.rjust(64,'0')])
  jobs.extend((name,address,lo,min(lo+1999,end),topics)for lo in range(start,end+1,2000))
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
  for row in ex.map(scan,jobs):
   out['ranges'].append(row)
   if len(out['ranges'])%50==0:(p/'progress.json').write_text(json.dumps({'completedRanges':len(out['ranges']),'total':len(jobs),'calls':count[0]}))
 for name,address,start,expected in streams:
  actual=[x for r in out['ranges']if r['stream']==name for x in r['logs']];expected=[norm(x)for x in expected]
  key=lambda x:(x['blockNumber'],x['logIndex']);actual.sort(key=key);expected.sort(key=key);assert actual==expected,name+' history disagreement'
 assert rpc('eth_getBlockByNumber',[hex(end),False])['hash']==out['blockHash']
 out['complete']=True;out['statement']='Full history agrees with independently captured API history at the same canonical block; current state and fresh tail still required.'
except Exception as e:out['error']=str(e)
out['calls']=count[0];(p/'result.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({k:v for k,v in out.items()if k!='ranges'}))

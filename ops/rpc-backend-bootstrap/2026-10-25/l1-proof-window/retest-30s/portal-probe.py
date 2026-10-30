#!/usr/bin/env python3
"""Read-only verified-EVM getter probe; not full A1 acceptance."""
import datetime,json,os,pathlib,signal,subprocess,sys,time
W=pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo')
P=W/'work/rpc-production-final-20261025'
HERE=pathlib.Path(__file__).resolve().parent
sys.path.insert(0,str(P/'finality-stage/l1-authority'))
import l1_authority as L
cfg=str(HERE/'config.json'); c=L.load_config(cfg)
url='http://127.0.0.1:28550'
portal='0x49048044d57e1c92a77f79988d21fa8faf74e97e'
r={'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'kind':'own-L1-Helios-verified-getter-probe','A1Accepted':False,
   'productionActivated':False,'portal':portal,'getter':'anchorStateRegistry()','selector':'0x5c0cba33',
   'note':'Getter is probed, not assumed implemented. All calls use the same light-client cached block hash; no public RPC fallback.'}
p=None
try:
 with (HERE/'portal-helios.out').open('x') as log:
  p=subprocess.Popen([sys.executable,str(P/'finality-stage/l1-authority/l1_authority.py'),'run',cfg],
                     stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  deadline=time.monotonic()+90
  while True:
   time.sleep(3)
   try:r['status']=L.status(c);break
   except Exception:
    if time.monotonic()>=deadline or p.poll() is not None:raise
  b=L.rpc(url,'eth_getBlockByNumber',['finalized',False],1,timeout=8)
  r['block']={k:b[k] for k in ('number','hash','stateRoot','timestamp')}
  block={'blockHash':b['hash'],'requireCanonical':True}
  value=L.rpc(url,'eth_call',[{'to':portal,'data':'0x5c0cba33'},block],1,timeout=30)
  r['portalGetterResult']=value
  assert isinstance(value,str) and len(value)==66 and value.startswith('0x'+'0'*24)
  asr='0x'+value[-40:];assert int(asr,16)>0
  r['asr']=asr
  proof=L.rpc(url,'eth_getProof',[asr,[],block],1,timeout=30)
  r['asrAccountProof']=proof
  r['readSucceeded']=True
except Exception as e:
 r['error']=type(e).__name__+': '+str(e)[:300]
finally:
 if p is not None and p.poll() is None:
  os.killpg(p.pid,signal.SIGTERM)
  try:p.wait(timeout=10)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
 r['processStopped']=p is not None and p.poll() is not None
 r['finishedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
 (HERE/'portal-result.json').write_text(json.dumps(r,indent=2))
print(json.dumps({k:v for k,v in r.items() if k not in ('asrAccountProof','status')}))
sys.exit(0 if r.get('readSucceeded') and r['processStopped'] else 1)

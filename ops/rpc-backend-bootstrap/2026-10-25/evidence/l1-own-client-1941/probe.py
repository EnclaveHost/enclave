#!/usr/bin/env python3
"""Bounded real light-client smoke; own L1 only; no consumer cutover or chain writes."""
import datetime,hashlib,json,os,pathlib,signal,socket,subprocess,sys,time
W=pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo')
P=W/'work/rpc-production-final-20261025'
O=W/'outputs/rpc-production-final-20261025'
HERE=pathlib.Path(__file__).resolve().parent
sys.path.insert(0,str(P/'finality-stage/l1-authority'))
import l1_authority as L
obs=json.loads((O/'l1-caught-up/fresh-finality-provenance-1941.json').read_text())
bootstrap=json.loads((O/'l1-caught-up/fresh-checkpoint-1940.json').read_text())
root=bootstrap['checkpointRoot']; slot=bootstrap['checkpointSlot']
assert slot%32==0
assert bootstrap['observations'][0]['http']==200
assert int(bootstrap['observations'][0]['body']['data']['header']['beacon']['slot'])==slot
sources=[]
for x in obs:
 f=x.get('body',{}).get('data',{}).get('finalized',{})
 assert x.get('http')==200 and f.get('root')==root and int(f['epoch'])*32==slot
 sources.append({'kind':'own-lighthouse' if x['url'].startswith('http://127.0.0.1:') else 'checkpoint-sync-provider',
                 'ref':x['url'],'observedAt':x['observedAt']})
assert len(sources)==5
for name in ['data','home']:
 (HERE/name).mkdir(mode=0o700)
cp={'format':L.CHECKPOINT_FORMAT,'network':'mainnet','root':root,'slot':slot,'sources':sources,
    'recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
(HERE/'checkpoint.json').write_text(json.dumps(cp,indent=2))
binary=W/'work/resume-after-checkpoint-20261022/witness-failover/bin/helios-eeffcc9'
cfg={'format':L.FORMAT,'network':'mainnet','binary':{'path':str(binary),'sha256':'cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0'},
     'consensusRpc':'http://127.0.0.1:25052','executionRpc':'http://127.0.0.1:28645',
     'listen':{'ip':'127.0.0.1','port':28550},'dataDir':str(HERE/'data'),'homeDir':str(HERE/'home'),
     'checkpointFile':str(HERE/'checkpoint.json'),'maxCheckpointAgeSec':604800,'maxFinalizedAgeSec':1800,'logFilter':'info'}
(HERE/'config.json').write_text(json.dumps(cfg,indent=2))
with socket.socket() as s:s.bind(('127.0.0.1',28550))
c=L.load_config(str(HERE/'config.json'))
fd=L.open_pinned(cfg['binary']);os.close(fd)
report={'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'kind':'bounded-own-L1-real-Helios-smoke',
        'binarySha256':cfg['binary']['sha256'],'checkpointRoot':root,'checkpointSlot':slot,
        'productionActivated':False,'statuses':[]}
p=None
try:
 with (HERE/'helios.out').open('x') as log:
  p=subprocess.Popen([sys.executable,str(P/'finality-stage/l1-authority/l1_authority.py'),'run',str(HERE/'config.json')],
                     stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  deadline=time.monotonic()+180; successes=0
  while time.monotonic()<deadline and p.poll() is None:
   time.sleep(5)
   try:
    status=L.status(c)
    b=L.rpc('http://127.0.0.1:28645','eth_getBlockByNumber',[hex(status['finalized']['number']),False],1)
    assert b['hash']==status['finalized']['hash'],'verified-finalized and local EL disagree'
    report['statuses'].append({'at':time.time(),'status':status,'localELMatches':True})
    successes+=1
    if successes>=3:break
   except Exception as e:
    report['statuses'].append({'at':time.time(),'unavailable':type(e).__name__+': '+str(e)[:200]})
  report['success']=successes>=3
  if p.poll() is not None:report['earlyExit']=p.returncode
finally:
 if p is not None and p.poll() is None:
  os.killpg(p.pid,signal.SIGTERM)
  try:p.wait(timeout=10)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
 report['processStopped']=p is not None and p.poll() is not None
 report['finishedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
 (HERE/'result.json').write_text(json.dumps(report,indent=2))
print(json.dumps({k:v for k,v in report.items() if k!='statuses'}))
sys.exit(0 if report.get('success') and report['processStopped'] else 1)

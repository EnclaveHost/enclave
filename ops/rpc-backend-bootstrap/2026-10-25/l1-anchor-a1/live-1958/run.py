import pathlib,json,subprocess,os,signal,time,sys,datetime,hashlib
W=pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo');P=W/'work/rpc-production-final-20261025'
O=W/'outputs/rpc-production-final-20261025';H=pathlib.Path(__file__).resolve().parent
sys.path.insert(0,str(P/'finality-stage/l1-authority'));import l1_authority as L
cfgfile=O/'l1-authority-live-1941/config.json';c=L.load_config(str(cfgfile))
proven=json.loads((O/'l1-proof-window/retest-30s/portal-result.json').read_text());assert proven['readSucceeded']
cfg=json.loads((P/'finality-stage/l1-anchor-a1/a1-config.example.json').read_text())
cfg.pop('_notes',None);cfg['heliosUrl']='http://127.0.0.1:28550';cfg['asr']=proven['asr'];cfg['maxFinalizedAgeSec']=1800
cfg['asrCandidates'].append({'address':proven['asr'],'provenance':'root Helios-verified portal getter at '+proven['block']['hash']})
(H/'a1-config.json').write_text(json.dumps(cfg,indent=2))
r={'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'productionActivated':False,'inputPins':{f:hashlib.sha256((P/'finality-stage/l1-anchor-a1'/f).read_bytes()).hexdigest() for f in ['a1-anchor.mjs','a1-read.mjs','vendor/anchor-bootstrap.mjs']}}
p=None
try:
 with (H/'helios.out').open('x') as log:
  p=subprocess.Popen([sys.executable,str(P/'finality-stage/l1-authority/l1_authority.py'),'run',str(cfgfile)],stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  end=time.monotonic()+90
  while True:
   time.sleep(3)
   try:r['heliosStatus']=L.status(c);break
   except Exception:
    if time.monotonic()>end or p.poll() is not None:raise
  env=dict(os.environ,ANCHOR_DEPS_ROOT=str(P/'source'))
  with (H/'a1-evidence.json').open('x') as out,(H/'a1.stderr').open('x') as err:
   x=subprocess.run(['node',str(P/'finality-stage/l1-anchor-a1/a1-read.mjs'),str(H/'a1-config.json')],env=env,stdout=out,stderr=err,timeout=240)
  r['a1Exit']=x.returncode
except Exception as e:r['error']=type(e).__name__+': '+str(e)[:300]
finally:
 if p is not None and p.poll() is None:
  os.killpg(p.pid,signal.SIGTERM)
  try:p.wait(timeout=10)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
 r['processStopped']=p is not None and p.poll() is not None
 r['finishedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
 (H/'run-result.json').write_text(json.dumps(r,indent=2))
print(json.dumps({k:v for k,v in r.items() if k!='heliosStatus'}))
sys.exit(0 if r.get('a1Exit')==0 and r['processStopped'] else 1)

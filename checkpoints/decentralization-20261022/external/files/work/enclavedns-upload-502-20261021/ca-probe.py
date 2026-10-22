import subprocess,json,pathlib
remote="""sudo python3 - <<'REMOTE'
import urllib.request,json,time,concurrent.futures
u='https://acme.zerossl.com/v2/DV90'
try:
 with urllib.request.urlopen(u,timeout=20) as r:d=json.loads(r.read(65536))
 u=d['newNonce']
 def probe(method):
  t=time.monotonic()
  try:
   with urllib.request.urlopen(urllib.request.Request(u,method=method),timeout=25) as r:return {'method':method,'status':r.status,'noncePresent':bool(r.headers.get('replay-nonce')),'seconds':round(time.monotonic()-t,2)}
  except Exception as e:return {'method':method,'error':type(e).__name__,'seconds':round(time.monotonic()-t,2)}
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as x: print(json.dumps(list(x.map(probe,['HEAD','GET']))))
except Exception as e:print(json.dumps({'directoryFailure':type(e).__name__}))
REMOTE"""
a=['ssh','-p32423','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','UserKnownHostsFile=work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1',remote]
r=subprocess.run(a,capture_output=True,text=True,timeout=55);out={'exit':r.returncode,'out':r.stdout,'err':r.stderr[:400]};pathlib.Path('work/enclavedns-upload-502-20261021/ca-probe.json').write_text(json.dumps(out,indent=2));print(json.dumps(out))

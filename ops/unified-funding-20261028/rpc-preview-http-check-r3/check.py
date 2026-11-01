import subprocess,time,urllib.request,urllib.error,json,sys
server=subprocess.Popen(['/usr/sbin/wasmtime','serve','--addr','127.0.0.1:22497',sys.argv[1]],stdout=(__import__('pathlib').Path(sys.argv[2])/'server.log').open('x'),stderr=subprocess.STDOUT)
try:
 for i in range(40):
  try:
   with urllib.request.urlopen('http://127.0.0.1:22497/',timeout=1) as r:
    body=r.read();assert r.status==200 and b'RPC is not operational' in body
   break
  except urllib.error.URLError:
   if server.poll() is not None:raise
   time.sleep(.1)
 else:raise RuntimeError('server not ready')
 for path,method in [('/', 'POST'),('/health','GET'),('/eth','POST')]:
  try:urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:22497'+path,method=method),timeout=2);raise AssertionError('expected 503')
  except urllib.error.HTTPError as e:assert e.code==503 and json.loads(e.read())['rpcReady'] is False
 with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:22497/',method='HEAD'),timeout=2) as r:assert r.status==200 and r.read()==b''
 print(json.dumps({'pass':5,'rpcReady':False}))
finally:
 server.terminate();server.wait(timeout=5)

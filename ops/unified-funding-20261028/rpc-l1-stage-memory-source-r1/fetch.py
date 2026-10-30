import pathlib,json,hashlib,urllib.request,time,os
p=pathlib.Path(__file__).resolve().parent
x=json.loads((p/'INPUT.json').read_text())
assert os.sched_getaffinity(0)=={1}
with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'noRetry':True},f)
u='https://raw.githubusercontent.com/paradigmxyz/reth/'+x['commit']+'/'+x['path']
try:
 with urllib.request.urlopen(u,timeout=20) as r:b=r.read(x['maxBytes']+1)
 assert len(b)<=x['maxBytes']
 assert hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()==x['gitBlobSha']
 with (p/'config.rs').open('xb') as f:f.write(b)
 z={'status':'EXACT_SOURCE_VERIFIED_NOT_EFFECTIVE_CONFIG','url':u,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'gitBlobSha':x['gitBlobSha']}
except Exception as e:
 z={'status':'FAILED','error':str(e)}
with (p/'RESULT.json').open('x') as f:json.dump(z,f,indent=2)
raise SystemExit(0 if z['status'].startswith('EXACT') else 1)

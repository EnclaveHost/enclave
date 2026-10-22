import hashlib,json,importlib.util,http.client,ssl
from pathlib import Path
HERE=Path(__file__).resolve().parent
OLD=HERE.parents[1]/'directory-https-activation/activation'
spec=importlib.util.spec_from_file_location('relay_route_engine',OLD/'activate.py');engine=importlib.util.module_from_spec(spec);spec.loader.exec_module(engine)
engine.CAND=HERE;engine.JOURNAL=HERE/'journal.jsonl'
engine.REMOTE='NO_MAIN=True\n'+(OLD/'remote.py').read_text()+'\n'+(HERE/'remote-overrides.py').read_text()
engine.IPS={k:engine.IPS[k] for k in ['us-west','eu-central']}
engine.HOST_PARAMS=dict(engine.HOST_PARAMS,peer_locks=['/opt/enclave-site/.site-release.lock','/etc/enclave-bootstrap-tls/directory-https.lock','/etc/enclave-bootstrap-tls/platform-policy.lock'])
record=json.loads((HERE.parent/'deployment.json').read_text())
identities={x['host']:x for x in json.loads((HERE.parents[2]/'outputs/app-lease-gas-review/lease-relay-identities.json').read_text())['identities']}
sha=lambda b:hashlib.sha256(b).hexdigest()
def expected(h):
 i=identities[h]
 address=i.get('address') or i.get('publicAddress')
 if not address:raise RuntimeError('missing reviewed public relay identity')
 return {'chainId':8453,'reserve':record['reserve'],'executor':record['executor'],'payee':address}
def manifest():
 validation=json.loads((HERE/'validation.json').read_text());checked={r['host']:r['sha256'] for r in validation['hosts']}
 hosts={}
 for h,ip in engine.IPS.items():
  b=(HERE/'baseline'/(h+'.Caddyfile')).read_bytes();a=(HERE/'result'/(h+'.Caddyfile')).read_bytes()
  assert sha(a)==checked[h]
  hosts[h]={'ip':ip,'base_sha256':sha(b),'result_sha256':sha(a),'result_bytes':len(a),'relay_info':expected(h)}
 doc={'schema':'enclave-lease-relay-route/v1','hosts':hosts,'hostParams':engine.HOST_PARAMS,'remoteSha256':sha(engine.REMOTE.encode()),'controllerSha256':sha(Path(__file__).read_bytes()),'engineSha256':sha((OLD/'activate.py').read_bytes())}
 text=json.dumps(doc,indent=2,sort_keys=True)+'\n';return doc,sha(text.encode()),text
originalRemote=engine.remote
def remote(h,mode,doc,run_id,timeout=None):
 old=engine.HOST_PARAMS
 try:
  engine.HOST_PARAMS=dict(old,relay_info=expected(h))
  return originalRemote(h,mode,doc,run_id,timeout)
 finally:engine.HOST_PARAMS=old

def request(ip,method,path,body=None):
 c=http.client.HTTPSConnection(ip,timeout=20,context=ssl.create_default_context())
 try:
  c.request(method,path,body=body,headers={'Content-Type':'application/json'} if body is not None else {})
  r=c.getresponse();return r.status,r.read(1024*1024)
 finally:c.close()
def readback(h,expect):
 try:
  s,b=request(engine.IPS[h],'GET','/v1/info')
  if expect=='inactive':return {'ok':s!=200 or b'canonicalLength' not in b,'state':'answered'}
  info=json.loads(b);assert s==200
  for k,v in expected(h).items():
   got=info.get(k);assert (got.lower()==v.lower() if isinstance(got,str) and isinstance(v,str) else got==v),(k,got,v)
  assert request(engine.IPS[h],'POST','/v1/lease',b'{}')[0]==400
  assert request(engine.IPS[h],'GET','/v1/lease')[0]==405
  s,b=request(engine.IPS[h],'GET','/v1/network/records');assert s==200 and json.loads(b).get('version')==1
  return {'ok':True,'state':'answered','relay':info,'tlsVerified':True,'directoryPreserved':True}
 except Exception as e:return {'ok':False,'state':'unknown' if isinstance(e,OSError) else 'answered','error':str(e)[:300]}
engine.manifest=manifest;engine.remote=remote;engine.public_readback=readback
if __name__=='__main__':raise SystemExit(engine.main())

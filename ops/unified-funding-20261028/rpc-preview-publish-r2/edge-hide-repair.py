import json,os,pathlib,hashlib,http.client,socket,subprocess
sha=lambda b:hashlib.sha256(b).hexdigest()
op=pathlib.Path("/var/lib/enclave-rpc-preview-artifacts-r1");cfg=pathlib.Path("/etc/enclave-bootstrap-tls/Caddyfile")
class U(http.client.HTTPConnection):
 def connect(self):
  self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(15);self.sock.connect('/run/enclave-bootstrap-tls/admin.sock')
def api(method='GET',body=None,etag=None):
 c=U('localhost');h={'Content-Type':'application/json'}
 if etag:h['If-Match']=etag
 try:
  c.request(method,'/config/',None if body is None else json.dumps(body),h);r=c.getresponse();data=r.read(2000001);assert r.status==200 and len(data)<=2000000
  return (json.loads(data) if data else None),r.getheader('ETag')
 finally:c.close()
def save(p,b,mode=0o600):
 with p.open('xb') as f:f.write(b);f.flush();os.fsync(f.fileno())
 os.chmod(p,mode)
expected=json.loads((op/'candidate.json').read_text());live,etag=api();assert live==expected and etag
fixed=json.loads(json.dumps(expected).replace(str(op/'candidate.Caddyfile'),str(cfg)))
actual=json.loads(subprocess.check_output(['/usr/local/lib/enclave-caddy/caddy','adapt','--config',str(cfg),'--adapter','caddyfile'],stderr=subprocess.DEVNULL));assert fixed==actual
save(op/'hide-repair-intent.json',json.dumps({'exactHidePathNormalization':True,'etag':etag}).encode())
api('PATCH',fixed,etag);assert api()[0]==actual
save(op/'RESULT.json',json.dumps({'ok':True,'files':6,'exactDiskAndLiveMatch':True,'hidePathsRepaired':True}).encode());print((op/'RESULT.json').read_text())

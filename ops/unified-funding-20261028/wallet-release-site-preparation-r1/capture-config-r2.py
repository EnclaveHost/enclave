import pathlib,json,hashlib,http.client,socket
p=pathlib.Path('/etc/enclave-bootstrap-tls/Caddyfile')
class U(http.client.HTTPConnection):
 def connect(self):
  self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(15);self.sock.connect('/run/enclave-bootstrap-tls/admin.sock')
c=U('localhost');c.request('GET','/config/');r=c.getresponse();assert r.status==200;cfg=json.loads(r.read(2000000));c.close()
roots=[]
def walk(v):
 if isinstance(v,dict):
  for k,x in v.items():
   if k=='root' and isinstance(x,str) and x.startswith('/opt/enclave-site/'): roots.append(x)
   walk(x)
 elif isinstance(v,list):
  for x in v:walk(x)
walk(cfg)
print(json.dumps({'config':cfg,'caddyfile':p.read_text(),'roots':roots}))

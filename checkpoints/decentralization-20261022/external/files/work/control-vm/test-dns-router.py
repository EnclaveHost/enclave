import socket,struct,threading,subprocess,time,json,pathlib
alive=True;control=True
listeners=[]
def answer(q,kind):
 end=12
 while q[end]:end+=q[end]+1
 end+=5
 typ=struct.unpack('!H',q[end-4:end-2])[0]
 payload=b''
 if typ==1:payload=b'\xc0\x0c'+struct.pack('!HHIH',1,1,15,4)+bytes([198,51,100,7] if kind=='routes' else [192,0,2,8])
 if typ in [16,255]:
  v=(b'authorized-challenge' if kind=='control' else b'local-route');payload=b'\xc0\x0c'+struct.pack('!HHIH',16,1,30,len(v)+1)+bytes([len(v)])+v
 return q[:2]+struct.pack('!HHHHH',0x8400,1,int(bool(payload)),0,0)+q[12:end]+payload

def readn(s,n):
 b=b''
 while len(b)<n:
  a=s.recv(n-len(b))
  if not a:raise EOFError()
  b+=a
 return b

def connection(s,kind):
 with s:
  s.settimeout(5)
  try:
   while alive:
    n=struct.unpack('!H',readn(s,2))[0];q=readn(s,n)
    if kind=='control' and not control:return
    r=answer(q,kind);s.sendall(struct.pack('!H',len(r))+r)
  except (OSError,EOFError):pass

def tcp(port,kind):
 s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('127.0.0.1',port));s.listen();s.settimeout(.5);listeners.append(s)
 while alive:
  try:c,_=s.accept();threading.Thread(target=connection,args=(c,kind),daemon=True).start()
  except TimeoutError:pass
  except OSError:return

def udp(port,kind):
 s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind(('127.0.0.1',port));s.settimeout(.5);listeners.append(s)
 while alive:
  try:
   q,a=s.recvfrom(8192);s.sendto(answer(q,kind),a)
  except TimeoutError:pass
  except OSError:return

def ask(name,typ=1,transport='udp'):
 q=struct.pack('!HHHHHH',0x4242,0x100,1,0,0,0)+b''.join(bytes([len(x)])+x.encode() for x in name.split('.'))+b'\0'+struct.pack('!HH',typ,1)
 with socket.socket(socket.AF_INET,socket.SOCK_STREAM if transport=='tcp' else socket.SOCK_DGRAM) as s:
  s.settimeout(7);s.connect(('127.0.0.1',2053))
  if transport=='tcp':s.sendall(struct.pack('!H',len(q))+q);return readn(s,struct.unpack('!H',readn(s,2))[0])
  s.send(q);return s.recv(8192)
for args in [(2054,'routes'),(2055,'control')]:threading.Thread(target=tcp,args=args,daemon=True).start()
threading.Thread(target=udp,args=(2054,'routes'),daemon=True).start()
log=open('/tmp/enclave-dns-router-test.log','wb');p=subprocess.Popen(['dnsdist','--supervised','--disable-syslog','-C','/tmp/enclave-dns-router.conf'],stdin=subprocess.DEVNULL,stdout=log,stderr=log)
try:
 time.sleep(2);checks=[]
 for transport in ['udp','tcp']:
  assert ask('abcd.app.enclave.host',transport=transport).endswith(bytes([198,51,100,7]));checks.append(transport+' app route')
  assert b'authorized-challenge' in ask('_acme-challenge.abcd.app.enclave.host',16,transport);checks.append(transport+' challenge via TCP backend')
  assert b'authorized-challenge' in ask('_AcMe-ChAlLeNgE.ABCD.App.Enclave.Host',16,transport);checks.append(transport+' case-insensitive challenge')
  assert ask('abcd.ip.enclave.host',transport=transport).endswith(bytes([192,0,2,8]));checks.append(transport+' raw-IP authority')
  assert ask('example.org',transport=transport)[3]&15==5;checks.append(transport+' unrelated zone refused')
 control=False;time.sleep(2)
 assert ask('abcd.app.enclave.host').endswith(bytes([198,51,100,7]));checks.append('app route survives challenge authority outage')
 try:r=ask('_acme-challenge.abcd.app.enclave.host',16);assert r[3]&15!=0 and b'authorized-challenge' not in r
 except TimeoutError:pass
 checks.append('challenge authority outage fails closed')
 print(json.dumps({'passed':len(checks),'checks':checks,'productionChanged':False}))
finally:
 alive=False;p.terminate();p.wait(timeout=10);log.close()
 for s in listeners:s.close()

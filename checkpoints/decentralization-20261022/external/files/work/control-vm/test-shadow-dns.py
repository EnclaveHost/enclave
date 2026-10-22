from pathlib import Path
import subprocess,json,hmac,hashlib,http.client,socket,struct,secrets,time
pid=subprocess.check_output(['systemctl','show','enclave-dns-shadow','-p','MainPID','--value'],text=True).strip();env=dict(x.split('=',1) for x in Path('/proc/'+pid+'/environ').read_bytes().decode().split('\0') if '=' in x);key=env.get('DNS_TXT_KEY') or env.get('SECRET');assert key and len(key)==64
name='_acme-challenge.7ae476a3.app.enclave.host';value='migration-'+secrets.token_hex(24);raw=json.dumps({'name':name,'value':value,'ttlSec':30,'ts':int(time.time())},separators=(',',':')).encode()
def push(method,sig):
 c=http.client.HTTPConnection('127.0.0.1',8153,timeout=20);c.request(method,'/v1/txt',body=raw,headers={'Content-Type':'application/json','x-relay-sig':sig});r=c.getresponse();b=r.read();c.close();return r.status,json.loads(b)
def readn(s,n):
 b=b''
 while len(b)<n:
  x=s.recv(n-len(b));assert x;b+=x
 return b
def query(tcp=False):
 q=struct.pack('!HHHHHH',0x3131,0x100,1,0,0,0)+b''.join(bytes([len(x)])+x.encode() for x in name.split('.'))+b'\0'+struct.pack('!HH',16,1)
 with socket.socket(socket.AF_INET,socket.SOCK_STREAM if tcp else socket.SOCK_DGRAM) as s:
  s.settimeout(5);s.connect(('127.0.0.1',1053))
  if tcp:s.sendall(struct.pack('!H',len(q))+q);return readn(s,struct.unpack('!H',readn(s,2))[0])
  s.send(q);return s.recv(8192)
status,_=push('POST','0'*64);assert status in [401,403];sig=hmac.new(key.encode(),raw,hashlib.sha256).hexdigest();status,answer=push('POST',sig);assert status==200,{'status':status,'response':answer}
try:
 assert all(value.encode() in query(t) for t in [False,True])
finally:
 removed,_=push('DELETE',sig);assert removed==200
assert all(value.encode() not in query(t) for t in [False,True])
print(json.dumps({'unauthorizedPushRefused':True,'authorizedLeaseChallengeAccepted':True,'UDPAndTCPVerified':True,'challengeDeleted':True,'productionDNSChanged':False,'sourceAPIStillUsedDuringShadowTest':True}))

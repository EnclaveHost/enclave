import subprocess,os,time,json,hashlib,tempfile
from pathlib import Path
assert hashlib.sha256(Path('/usr/sbin/qemu-nbd').read_bytes()).hexdigest()=='b0f16ff7225e78469733132fce225b1d0af98f0b681a5092d85618936ff61934'
assert hashlib.sha256(Path('/client').read_bytes()).hexdigest()=='0a256b67962d1ffc1ab8bacecd4319b8e459a0535467abb66f83329ce5221167'
def run(args):
 r=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
 assert len(r.stdout)+len(r.stderr)<65536
 return r
r=run(['/usr/sbin/ip','link','set','lo','up']);assert r.returncode==0, ('private-loopback',r.stderr.decode(errors='replace'))
with tempfile.TemporaryDirectory(dir='/tmp') as td:
 os.chdir(td);os.umask(0o077)
 def ok(args):
  r=run(args);assert r.returncode==0, {'command':args[0], 'rc':r.returncode}
 ok(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca-key.pem','-out','ca-cert.pem','-days','1','-subj','/CN=rpc-fixture-ca'])
 for name,cn,usage in [('server','rpc-fixture-server','serverAuth'),('client','rpc-fixture-client','clientAuth'),('other','rpc-fixture-other','clientAuth')]:
  ok(['openssl','req','-newkey','rsa:2048','-nodes','-keyout',name+'-key.pem','-out',name+'.csr','-subj','/CN='+cn])
  Path(name+'.ext').write_text('extendedKeyUsage='+usage+'\nsubjectAltName=DNS:'+cn+'\n')
  ok(['openssl','x509','-req','-in',name+'.csr','-CA','ca-cert.pem','-CAkey','ca-key.pem','-CAcreateserial','-out',name+'-cert.pem','-days','1','-extfile',name+'.ext'])
 with open('dummy.raw','wb') as f:f.truncate(1048576)
 log=open('server.log','wb');server=subprocess.Popen(['/usr/sbin/qemu-nbd','--persistent','--bind','127.0.0.1','--port','10809','--export-name','fixture','--shared=1','--format=raw','--read-only','--object','tls-creds-x509,id=tls0,endpoint=server,dir='+td+',verify-peer=on','--object','authz-simple,id=auth0,identity=CN=rpc-fixture-client','--tls-creds','tls0','--tls-authz','auth0','dummy.raw'],stdout=log,stderr=log)
 try:
  time.sleep(.3);assert server.poll() is None,'server-start'
  base=['/client','-x','-A','ca-cert.pem','-H','rpc-fixture-server']
  cases=[('authorized',base+['-F','client-cert.pem','-K','client-key.pem','-l','127.0.0.1'],True),('wrong-name',['/client','-x','-A','ca-cert.pem','-H','wrong.invalid','-F','client-cert.pem','-K','client-key.pem','-l','127.0.0.1'],False),('missing-client-cert',base+['-l','127.0.0.1'],False),('unauthorized-client',base+['-F','other-cert.pem','-K','other-key.pem','-l','127.0.0.1'],False),('plaintext',['/client','-l','127.0.0.1'],False),('authorized-after-rejections',base+['-F','client-cert.pem','-K','client-key.pem','-l','127.0.0.1'],True)]
  out=[]
  for name,args,expected in cases:
   r=run(args);assert server.poll() is None,'server-died';success=r.returncode==0 and b'fixture' in r.stdout+r.stderr
   out.append({'case':name,'rc':r.returncode,'exportVisible':success,'expectedSuccess':expected,'pass':success if expected else r.returncode!=0,'stdout':r.stdout.decode(errors='replace'),'stderr':r.stderr.decode(errors='replace')})
  print(json.dumps({'cases':out,'allPass':all(x['pass'] for x in out),'privateNetworkNamespace':True,'dummyBytes':1048576,'productionData':False,'keysExported':False}),flush=True)
  assert all(x['pass'] for x in out),'auth-case-failure'
 finally:
  server.terminate()
  try:server.wait(timeout=3)
  except subprocess.TimeoutExpired:server.kill();server.wait(timeout=3)
  log.close()

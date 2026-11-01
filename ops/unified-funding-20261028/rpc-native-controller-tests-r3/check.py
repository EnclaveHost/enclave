import subprocess,time,json,sys,http.server,threading,urllib.request,urllib.error,pathlib,socket
subprocess.run(['/usr/sbin/ip','link','set','lo','up'],check=True)
state={'fault':'','sent':0};now=int(time.time());h=lambda n:'0x'+format(n,'064x')
def block(n):return {'number':hex(n),'hash':h(n),'timestamp':hex(now-(30-n))}
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_GET(self):
  data={'/eth/v1/node/syncing':{'is_syncing':False,'is_optimistic':state['fault']=='optimistic','el_offline':False},'/eth/v1/beacon/genesis':{'genesis_validators_root':'0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95'},'/eth/v2/beacon/blocks/finalized':{'message':{'body':{'execution_payload':{'block_number':'10','block_hash':h(10)}}}}}
  self.send_json({'data':data[self.path]})
 def do_POST(self):
  q=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  def item(q):
   m=q['method'];p=q['params'];port=self.server.server_port
   if m=='eth_chainId':r=hex(2 if state['fault']=='base' and port==18545 else 1 if port==18645 else 8453)
   elif m=='eth_syncing':r=False
   elif m=='eth_getBlockByNumber':r={'hash':'0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3'} if p[0]=='0x0' else block({'latest':30,'safe':20,'finalized':10,'0xa':10}[p[0]])
   elif m=='optimism_syncStatus':r={'safe_l2':{'number':20,'hash':h(20)},'finalized_l2':{'number':10,'hash':h(10)}}
   elif m=='eth_sendRawTransaction':state['sent']+=1;r=h(100)
   elif m=='eth_blockNumber':r='0x1e'
   else:raise AssertionError(m)
   return {'jsonrpc':'2.0','id':q['id'],'result':r}
  self.send_json([item(x) for x in q] if isinstance(q,list) else item(q))
 def send_json(self,v):
  b=json.dumps(v).encode();self.send_response(200)
  if self.server.server_port==18545:
   self.send_header('Transfer-Encoding','chunked');self.end_headers();self.wfile.write(format(len(b),'x').encode()+b'\r\n'+b+b'\r\n0\r\n\r\n')
  elif self.server.server_port==15052:
   self.end_headers();self.wfile.write(b) # close delimiting
  else:
   self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)
servers=[];threads=[];child=None;checks=[]
def call(path,method='GET',data=None):
 body=None if data is None else json.dumps(data).encode();req=urllib.request.Request('http://127.0.0.1:8000'+path,data=body,method=method,headers={'Content-Type':'application/json'})
 try:r=urllib.request.urlopen(req,timeout=12)
 except urllib.error.HTTPError as e:r=e
 with r:return r.status,json.loads(r.read() or b'null')
def q(m='eth_blockNumber',id=7):return {'jsonrpc':'2.0','id':id,'method':m,'params':[]}
try:
 for port in [18645,18545,15052,19545]:
  server=http.server.HTTPServer(('127.0.0.1',port),Handler);server.timeout=1;servers.append(server)
  t=threading.Thread(target=server.serve_forever,kwargs={'poll_interval':.05},daemon=True);t.start();threads.append(t)
 child=subprocess.Popen(['/usr/sbin/wasmtime','run','-Cparallel-compilation=n','-Scli,inherit-network=y','-Wmax-memory-size=67108864,timeout=35s',sys.argv[1]],stdin=subprocess.DEVNULL,stdout=(pathlib.Path(sys.argv[2])/'wasmtime.log').open('x'),stderr=subprocess.STDOUT,env={'PATH':'/usr/bin:/bin','HOME':'/tmp'})
 for i in range(50):
  try:status,v=call('/');assert status==200;break
  except urllib.error.URLError:
   if child.poll() is not None:raise RuntimeError('WASI controller exited')
   time.sleep(.1)
 else:raise RuntimeError('listener missing')
 checks.append('real WASI root listener')
 assert call('/health')==(200,{'localReady':True,'chains':[1,8453]});checks.append('whole stack fixture readiness')
 status,v=call('/ethereum','POST',q());assert status==200 and v['id']==7 and v['result']=='0x1e';checks.append('ethereum forwarding')
 status,v=call('/base','POST',[q(id=1),q(id=2)]);assert status==200 and len(v)==2;checks.append('base chunked batch forwarding')
 status,v=call('/base','POST',q('eth_sendRawTransaction'));assert status==200 and state['sent']==1;checks.append('single transaction forwarding')
 state['fault']='base';assert call('/base','POST',q('eth_sendRawTransaction'))[0]==503 and state['sent']==1;checks.append('unready blocks submission')
 state['fault']='optimistic';assert call('/health')[0]==503;checks.append('optimistic consensus refusal')
 state['fault']='';assert call('/base','POST',q('engine_getPayloadV3'))[0]==400;checks.append('engine refused')
 assert call('/health','HEAD')==(200,None);checks.append('HEAD no body')
 print(json.dumps({'pass':len(checks),'checks':checks,'fixtureClients':True,'productionRPC':False}))
finally:
 if child is not None:
  child.terminate();child.wait(timeout=5)
 for server in servers:server.shutdown();server.server_close()
 for t in threads:t.join(timeout=1)

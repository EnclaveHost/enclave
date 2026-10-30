import contextlib,shutil,hashlib,http.client,http.server,importlib.util,io,json,os,signal,socket,subprocess,sys,tempfile,threading,time,types
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parent
SRC=ROOT.parent/'session-gate-source'
sys.path.insert(0,str(SRC))
import session_gate as g
import interruption_watchdog as w
assert os.geteuid()==0, 'run in mapped-root isolated user namespace'
subprocess.run(['ip','link','set','lo','up'],check=True)
assert hashlib.sha256((ROOT/'caddy').read_bytes()).hexdigest()=='b7105518e3ed1c0761f232e44fc09345535533c9cb0abf0e12809416c7ac64d9'
checks=[];requests=[]
def record(name):checks.append(name);print('PASS',name,flush=True)
def port():
 with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
class Mock(http.server.BaseHTTPRequestHandler):
 def serve(self):
  requests.append((self.command,self.path));b=json.dumps({'mock':True,'method':self.command,'path':self.path}).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(b)));self.end_headers()
  if self.command!='HEAD':self.wfile.write(b)
 do_GET=do_HEAD=do_OPTIONS=do_POST=do_PUT=do_PATCH=do_DELETE=serve
 def log_message(self,*a):pass
up=http.server.ThreadingHTTPServer(('127.0.0.1',0),Mock);threading.Thread(target=up.serve_forever,daemon=True).start()
work=Path(tempfile.mkdtemp(prefix='cg-'));work.chmod(0o700)
admin=work/'admin.sock';g.SOCKET=str(admin);g.BACKUPS=work/'ops';g.BACKUPS.mkdir(mode=0o700);w.WATCH=work/'watchdogs'
proxy={'handler':'reverse_proxy','upstreams':[{'dial':f'127.0.0.1:{up.server_port}'}]}
base=[{'match':[{'host':[h]}],'handle':[{'handler':'subroute','routes':[{'handle':[proxy]}]}],'terminal':True} for h in g.HOSTS+['*.app.enclave.host']]
listen=port();cfg={'admin':{'listen':'unix/'+str(admin),'config':{'persist':False}},'apps':{'http':{'servers':{'control':{'listen':[f'127.0.0.1:{listen}'],'protocols':['h1','h2'],'automatic_https':{'disable':True},'routes':base}}}}}
(work/'caddy.json').write_text(json.dumps(cfg));env={**os.environ,'HOME':str(work),'XDG_DATA_HOME':str(work/'data'),'XDG_CONFIG_HOME':str(work/'config'),'GOMEMLIMIT':'160MiB','GOMAXPROCS':'1'}
log=(ROOT/'caddy.log').open('w');proc=subprocess.Popen([str(ROOT/'caddy'),'run','--config',str(work/'caddy.json')],stdout=log,stderr=log,env=env)
def call(method,path,host):
 c=http.client.HTTPConnection('127.0.0.1',listen,timeout=5)
 try:c.request(method,path,headers={'Host':host});r=c.getresponse();b=r.read();return r.status,dict(r.getheaders()),b
 finally:c.close()
def cli(*args):
 with patch.object(sys,'argv',['session_gate.py',*args]),contextlib.redirect_stdout(io.StringIO()) as out:g.main()
 return json.loads(out.getvalue())
def install(op):
 routes,etag=g.read_routes();return cli('gate','--op',op,'--expected-hash',g.digest(routes),'--expected-etag',etag,'--apply')
def restore(op):
 routes,etag=g.read_routes();return cli('restore','--op',op,'--expected-hash',g.digest(routes),'--expected-etag',etag,'--apply')
def state(op):return json.loads((g.BACKUPS/op/'state.json').read_text())
def expect_error(fn,typ=RuntimeError):
 try:fn()
 except typ:return
 raise AssertionError('expected exception')
try:
 deadline=time.monotonic()+15
 while True:
  try:g.read_routes();break
  except Exception:
   if proc.poll() is not None or time.monotonic()>deadline:raise
   time.sleep(.1)
 record('matching Caddy v2.11.4 actual Unix admin and loopback HTTP boot')
 for h in g.HOSTS:assert call('POST','/v1/sessions/execute',h)[0]==200
 install('fixture-primary-r1');record('actual helper CLI root-only backup + ETag PATCH gate accepted')
 before=len(requests)
 for h in g.HOSTS:
  for method in ['POST','PUT','PATCH','DELETE']:
   for path in ['/v1/sessions','/v1/sessions/execute','/v1/sessions?x=1']:
    code,headers,body=call(method,path,h);assert code==503,(h,method,path,code);assert json.loads(body)['code']=='session_maintenance';assert headers.get('Retry-After')=='60'
 assert len(requests)==before
 record('all five exact control hosts: 60 mutation cases denied before mock upstream')
 for h in g.HOSTS:
  for method in ['GET','HEAD','OPTIONS']:assert call(method,'/v1/sessions/owner/fixture',h)[0]==200
 record('GET/HEAD/OPTIONS owner visibility preserved on all five hosts')
 for method,path,host in [('POST','/v1/deployments','api.enclave.host'),('GET','/health','api.enclave.host'),('POST','/rpc/base','api.enclave.host'),('POST','/v1/sessionsXYZ','api.enclave.host'),('POST','/v1/sessions','fixture.app.enclave.host')]:assert call(method,path,host)[0]==200
 record('unrelated API/RPC/deployment and wildcard tenant routes preserved')
 for path in ['/v1/other/../sessions','/v1/sessions/../sessions','/v1/sessions/execute?x=1']:
  assert call('POST',path,'api.enclave.host')[0]==503,path
 assert call('POST','/v1/sessions','API.ENCLAVE.HOST:443')[0]==503
 record('dot-normalized paths, query and uppercase host-with-port gated')
 routes,oldtag=g.read_routes();other={'@id':'fixture-unrelated','match':[{'path':['/fixture-unrelated']}],'handle':[{'handler':'static_response','body':'retained','status_code':200}],'terminal':True}
 g.api('PATCH',g.ROUTES,[other]+routes,oldtag)
 expect_error(lambda:g.api('PATCH',g.ROUTES,routes,oldtag));assert g.read_routes()[0]==[other]+routes
 record('actual Caddy If-Match stale ETag refused without overwriting concurrent route')
 restore('fixture-primary-r1');assert g.read_routes()[0]==[other]+base;assert call('POST','/v1/sessions','api.enclave.host')[0]==200
 record('owned-route rollback preserves concurrent unrelated route and reopens writes')
 # Simulate lost response AFTER actual server applied gate; never replay mutation.
 op='fixture-unknown-r1';routes,etag=g.read_routes();opdir=g.BACKUPS/op;opdir.mkdir(mode=0o700);s={'op':op,'owned':g.gate_route(op),'beforeHash':g.digest(routes),'phase':'prepared'};g.save(opdir/'state.json',s);realapi=g.api;sent=[]
 def lost(*args,**kwargs):
  result=realapi(*args,**kwargs)
  if args[0]=='PATCH':sent.append(1);raise TimeoutError('fixture response lost after commit')
  return result
 with patch.object(g,'api',lost):expect_error(lambda:g.mutate('PATCH',[s['owned']]+routes,etag,s,opdir/'state.json','gate'),TimeoutError)
 assert len(sent)==1 and state(op)['phase']=='gate-unknown';assert cli('status','--op',op)['ownedGateExact'];restore(op)
 record('lost post-commit response: durable unknown, one PATCH, read reconcile and exact rollback')
 op='fixture-altered-r1';install(op);routes,etag=g.read_routes();changed=json.loads(json.dumps(routes));changed[0]['handle'][0]['body']='changed by fixture';g.api('PATCH',g.ROUTES,changed,etag)
 expect_error(lambda:restore(op));assert g.read_routes()[0]==changed
 # fixture-only cleanup, never a recommended recovery for a changed production gate.
 routes,etag=g.read_routes();g.api('PATCH',g.ROUTES,[other]+base,etag)
 record('altered owned gate rollback refused on actual admin state')
 # Full watchdog main with simulated time only: actual API, filesystem/root checks,
 # locking, durable state and Caddy operations. No real service/source identity call.
 baseline={'pid':999,'startTicks':'123','sources':w.PINS}
 def watchdog(op):
  clock=[1000.0];fake=types.SimpleNamespace(time=lambda:clock[0],monotonic=lambda:clock[0],sleep=lambda n:clock.__setitem__(0,clock[0]+n))
  with patch.object(w,'relay_identity',return_value=baseline),patch.object(w,'time',fake),patch.object(sys,'argv',['watchdog','--op',op,'--seconds','60','--apply']),contextlib.redirect_stdout(io.StringIO()):w.main()
 op='fixture-watchdog-r1';install(op);watchdog(op);assert call('POST','/v1/sessions','api.enclave.host')[0]==200;assert g.read_routes()[0]==[other]+base
 record('watchdog full main simulated deadline: exact CAS recovery against real Caddy')
 op='fixture-watchmarker-r1';install(op);wd=w.WATCH/op;wd.mkdir(mode=0o700);g.save(wd/'activation-started.json',{'activation':True})
 expect_error(lambda:watchdog(op),SystemExit);assert cli('status','--op',op)['ownedGateExact'];restore(op)
 record('watchdog activation marker retains gate at deadline; manual exact restore works')
 op='fixture-watchlost-r1';install(op);sent=[]
 with patch.object(g,'api',lost):expect_error(lambda:watchdog(op),SystemExit)
 assert len(sent)==1;assert json.loads((w.WATCH/op/'watchdog.json').read_text())['outcome']['outcome']=='manual-review'
 with patch.object(g,'api',side_effect=AssertionError('must not resend')):watchdog(op)
 assert g.read_routes()[0]==[other]+base
 record('watchdog lost restore response preserves unknown and restart never resends')
 result={'ok':True,'checks':checks,'caddySha256':hashlib.sha256((ROOT/'caddy').read_bytes()).hexdigest(),'caddyVersion':'2.11.4','sourceHashes':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in [SRC/'session_gate.py',SRC/'interruption_watchdog.py']},'fixture':{'network':'isolated user+network namespace, loopback only','admin':'private Unix socket','upstream':'in-process mock, no apps or RPC','root':'mapped namespace root, no host sudo'},'limitations':['Watchdog deadline fast-forwarded with fixture clock; relay identity is a fixture, not production process.','Actual systemd watchdog installation/restart not exercised; source unit template remains uninstalled.','Production TLS private keys/config were not loaded; actual route shapes/host matchers and matching Caddy binary used with loopback HTTP.'],'productionMutations':[]}
 (ROOT/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'ok':True,'checks':len(checks)}),flush=True)
finally:
 proc.terminate()
 try:proc.wait(timeout=5)
 except subprocess.TimeoutExpired:proc.kill();proc.wait()
 log.close();up.shutdown();up.server_close()
 admin.unlink(missing_ok=True)
 shutil.copytree(work,ROOT/'fixture-final',dirs_exist_ok=True);shutil.rmtree(work)

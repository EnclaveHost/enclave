# Relay-specific readback on the existing compare-and-swap/rollback controller.
PREPARED=CF.with_name(CF.name+'.lease-relay-prepared')
BACKUP=CF.with_name(CF.name+'.before-lease-relay')
JOURNAL=CF.with_name('lease-relay.journal.jsonl')
LOCK=CF.with_name('lease-relay.lock')
def running_has_route():
 try:
  c=UnixHTTP(P['admin_socket']);c.request('GET','/config/apps/http',headers={'Host':'localhost'})
  r=c.getresponse();doc=json.loads(r.read());c.close()
  if r.status!=200:return None
  text=json.dumps(doc)
  return '127.0.0.1:8549' in text and '/v1/info' in text and '/v1/lease' in text
 except Exception:return None

def validate(path):
 with tempfile.TemporaryDirectory() as t:
  env=dict(os.environ,XDG_DATA_HOME=t+'/data',XDG_CONFIG_HOME=t+'/config')
  r=subprocess.run([P['caddy'],'validate','--config',str(path),'--adapter','caddyfile'],capture_output=True,text=True,env=env,timeout=120)
 if r.returncode:raise RuntimeError('Caddy validate failed: '+r.stderr[-1000:])

def verify(pre):
 if running_has_route() is not True:raise RuntimeError('running relay route absent')
 s,h,b=https('GET','/v1/info');info=json.loads(b)
 if s!=200:raise RuntimeError('relay info failed')
 for k,v in P['relay_info'].items():
  got=info.get(k);assert (got.lower()==v.lower() if isinstance(got,str) and isinstance(v,str) else got==v),(k,got,v)
 s,h,b=https('POST','/v1/lease',{'Content-Type':'application/json'},b'{}')
 if s!=400:raise RuntimeError('malformed lease refusal failed: '+str(s))
 for method,path in [('POST','/v1/info'),('GET','/v1/lease'),('DELETE','/v1/lease')]:
  if https(method,path)[0]!=405:raise RuntimeError('method refusal failed')
 s,h,b=https('GET','/v1/network/records');ds,db=direct('/v1/network/records')
 if s!=200 or ds!=200 or json.loads(b).get('version')!=1:raise RuntimeError('existing directory readback failed')
 ids=lambda raw:sorted(x['record']['record']['providerId'] for x in json.loads(raw).get('providers',[]))
 if ids(b)!=ids(db):raise RuntimeError('directory differs from local')
 post=legacy_probe()
 if any('status' not in pre[p] or post[p].get('status')!=pre[p]['status'] or post[p].get('directoryShaped') for p in LEGACY):raise RuntimeError('legacy route status changed')
 return {'relay':info,'invalidLeaseRefused':True,'wrongMethodsRefused':True,'directoryPreserved':True,'legacy':post}
main()

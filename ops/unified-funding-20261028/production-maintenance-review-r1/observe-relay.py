import sys,json,hashlib,time,pathlib,subprocess
sys.path.insert(0,'/opt/enclave-funding-staged/maintenance-r1')
import session_gate as g
p=pathlib.Path('/var/lib/enclave-relay');raw=(p/'sessions-relayer.json').read_bytes();j=json.loads(raw);idx=json.loads((p/'sessions-index.json').read_text())
status={}
for t in j['txs']:status[t['status']]=status.get(t['status'],0)+1
num=lambda x:int(str(x).removesuffix('n'))
live=[s for s in idx['sessions'].values() if not s.get('ended')]
expiry=[num(s['expiresAt']) for s in live];now=int(time.time())
routes,etag=g.read_routes();ups,_=g.api('GET','/reverse_proxy/upstreams')
pid=int(subprocess.check_output(['systemctl','show','enclave-api-relay.service','-p','MainPID','--value'],text=True).strip())
out={'at':now,'pid':pid,'journalSha256':hashlib.sha256(raw).hexdigest(),'journalCount':len(j['txs']),'journalStatuses':status,'journalLastAt':max([str(t.get('at','')) for t in j['txs']],default=None),'indexCount':len(idx['sessions']),'liveCount':len(live),'expiredCount':sum(t<=now for t in expiry),'expiresWithin20Minutes':sum(t<=now+1200 for t in expiry),'nextExpiry':min(expiry,default=None),'routesSha256':g.digest(routes),'etag':etag,'gateIds':[r.get('@id') for r in routes if str(r.get('@id','')).startswith('session-write-gate-')],'upstreams':ups}
print(json.dumps(out))
if pid<=0 or any(k!='mined' for k in status) or out['expiresWithin20Minutes']:sys.exit(2)

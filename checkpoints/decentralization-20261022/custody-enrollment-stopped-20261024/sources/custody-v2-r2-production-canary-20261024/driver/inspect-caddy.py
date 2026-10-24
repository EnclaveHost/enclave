"""Read-only control-VM inspection; no config writes/reload. Only curated hashes/counts leave the VM."""
import json,hashlib,subprocess,urllib.request,time,re,os

def require(ok,why):
 if not ok:raise ValueError(why)
def digest(v):return hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
def groups(v):
 if isinstance(v,dict):
  return ([v['group']] if 'group' in v else [])+sum((groups(x) for x in v.values() if isinstance(x,(dict,list))),[])
 if isinstance(v,list):return sum((groups(x) for x in v),[])
 return []
def normalize(v,table=None):
 if table is None:table={}
 if isinstance(v,dict):
  out={}
  for k,x in v.items():
   if k=='group':
    require(isinstance(x,str),'invalid Caddy group');table.setdefault(x,'group'+str(len(table)));out[k]=table[x]
   else:out[k]=normalize(x,table)
  return out
 if isinstance(v,list):return [normalize(x,table) for x in v]
 return v
def selected(config,hostname):
 candidates=[]
 servers=config.get('apps',{}).get('http',{}).get('servers',{})
 require(isinstance(servers,dict),'no HTTP server map')
 for server in servers.values():
  listen=server.get('listen',[])
  require(isinstance(listen,list) and all(isinstance(p,str) for p in listen),'invalid listeners')
  require(not any(p.endswith(':443') and p not in (':443','0.0.0.0:443','[::]:443') for p in listen),'unreviewed specific-address HTTPS server')
  if not any(p in (':443','0.0.0.0:443','[::]:443') for p in listen):continue
  require(isinstance(server.get('routes'),list),'HTTPS routes unavailable')
  for route in server['routes']:
   match=route.get('match')
   require(isinstance(match,list) and len(match)==1 and isinstance(match[0],dict) and set(match[0])=={'host'},'ambiguous HTTPS route can precede canary')
   hosts=match[0]['host'];require(isinstance(hosts,list) and hosts,'invalid host matcher')
   for host in hosts:
    require(isinstance(host,str) and re.fullmatch(r'(?:\*\.)?[a-z0-9.-]+',host),'unreviewed host matcher')
    matches=host==hostname or (host.startswith('*.') and hostname.endswith(host[1:]) and hostname.count('.')==host.count('.'))
    if matches:
     require(hosts==[hostname],'overlapping wildcard/shared host matcher');candidates.append(route)
 require(len(candidates)==1,'dedicated origin is absent or ambiguous')
 return candidates[0]
def validate_live(live,expected,hostname):
 route=selected(live,hostname);want=selected(expected,hostname)
 require(normalize(route)==normalize(want),'live route differs from reviewed exact allowlist')
 allgroups=groups(live);own=groups(route)
 for g in set(own):require(allgroups.count(g)==own.count(g),'canary group reused outside origin')
 return digest(normalize(route))
def main(request):
 try:
  hostname=request['hostname'];require(re.fullmatch(r'[a-z0-9.-]+',hostname),'invalid hostname')
  port=request['tunnelPort'];require(isinstance(port,int) and 1024<=port<=65535,'invalid loopback port')
  caddy=request['caddy'];require(isinstance(caddy,str) and len(caddy)<16384,'bounded Caddy input required')
  adapted=subprocess.run(['caddy','adapt','--config','/dev/stdin','--adapter','caddyfile'],input=caddy,text=True,capture_output=True,timeout=10)
  require(adapted.returncode==0 and len(adapted.stdout)<262144,'Caddy adaptation failed');expected=json.loads(adapted.stdout)
  with urllib.request.urlopen('http://127.0.0.1:2019/config/',timeout=10) as r:
   require(r.status==200,'Caddy running config unavailable');raw=r.read(8*1024*1024+1)
  require(len(raw)<=8*1024*1024,'running config exceeds limit');routehash=validate_live(json.loads(raw),expected,hostname)
  listeners=[]
  for kind in ['tcp','tcp6']:
   for line in open('/proc/net/'+kind).read().splitlines()[1:]:
    f=line.split();addr,p=f[1].split(':')
    if int(p,16)==port and f[3]=='0A':listeners.append((kind,addr,int(f[7])))
  require(listeners==[('tcp','0100007F',os.getuid())],'reverse port is not an exclusive same-user loopback listener')
  print(json.dumps({'ok':True,'at':int(time.time()*1000),'hostname':hostname,'tunnelPort':port,'routeSha256':routehash,'loopbackListener':True,'scope':'SSH-authenticated running Caddy config and listener inspection; no mutation'}))
 except Exception:
  print(json.dumps({'ok':False,'error':'control-VM running route or loopback listener could not be verified'}));raise SystemExit(1)

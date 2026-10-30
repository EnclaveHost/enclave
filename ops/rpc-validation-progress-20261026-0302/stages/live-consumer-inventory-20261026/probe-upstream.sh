echo "utc=$(date -u +%FT%TZ) host=$(hostname)"
for port in 30443 30080; do ss -ltnpH "sport = :$port" 2>/dev/null | while read -r st rq sq loc peer proc; do
  pid=$(echo "$proc" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2); name=$(echo "$proc" | grep -oE '"[^"]+"' | head -1)
  exe=$(readlink /proc/$pid/exe 2>/dev/null); unit=$(grep -oE '[^/]+\.(service|scope)' /proc/$pid/cgroup 2>/dev/null | head -1)
  scr=$(tr '\0' '\n' < /proc/$pid/cmdline 2>/dev/null | grep -m1 -E '^/[^ =]*\.(m?js|cjs)$')
  h=""; [ -n "$scr" ] && h=$(sha256sum "$scr" 2>/dev/null | cut -c1-16)
  echo "upstream_listen $loc name=$name pid=$pid unit=$unit exe=$exe script=$scr sha16=$h"; done; done
[ -z "$(ss -ltnH 'sport = :30443' 2>/dev/null)" ] && echo "upstream_listen none_on_30443"
nft list ruleset 2>/dev/null | grep -E 'dport (30443|30080)' | sed -E 's/#.*//' | head -5 | sed 's/^/nat_rule /'
curl -s --max-time 6 http://127.0.0.1:8188/v1/network/routes | python3 -c "
import json,sys,re
from urllib.parse import urlsplit
d=json.load(sys.stdin)
def san(s):
  s=str(s)
  if re.match(r'^[a-z]+://',s): u=urlsplit(s); return f'{u.scheme}://{u.hostname}'+(f':{u.port}' if u.port else '')
  return s[:80]
SAFE=re.compile(r'(?i)^(id|name|kind|label|labels|app|appId|image|imageDigest|measurement|version|commit|region|host|hostId|hosts|domain|domains|names|status|state|updatedAt|createdAt|vmId|tier|target|targets|upstream|port|ports|zone)$')
def walk(x,p=''):
  if isinstance(x,dict):
    for k,v in x.items():
      if re.search(r'(?i)token|secret|key|cookie|password|auth|cert|seal|sig',str(k)): continue
      yield from walk(v,p+'/'+str(k))
  elif isinstance(x,list):
    for i,v in enumerate(x[:12]): yield from walk(v,p+f'[{i}]')
  else: yield p,x
print('updatedAt',d.get('updatedAt'),'transport',san(d.get('transport')) if not isinstance(d.get('transport'),(dict,list)) else type(d.get('transport')).__name__)
for sect in ('labels','deployments','pending'):
  for p,v in walk(d.get(sect),sect):
    leaf=p.rsplit('/',1)[-1].split('[')[0]
    if SAFE.match(leaf) or re.search(r'enclave\.host|enclavehost\.eth',str(v)): print(' route',p[:110],'=',san(v))
" 2>&1 | head -70

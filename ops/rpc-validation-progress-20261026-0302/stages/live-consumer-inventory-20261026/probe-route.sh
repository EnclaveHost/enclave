echo "utc=$(date -u +%FT%TZ) host=$(hostname)"
u=$(systemctl show enclave-route-dns -p Environment 2>/dev/null | tr ' ' '\n' | sed -n 's/^ROUTE_MAP_URL=//p' | sed 's/[?#].*//' | head -1)
echo "route_map_url=$u"
[ -n "$u" ] && curl -s --max-time 6 "$u" -o /tmp/.rm.$$ 2>/dev/null && python3 - /tmp/.rm.$$ <<'PY'
import json,sys,re
from urllib.parse import urlsplit
try: d=json.load(open(sys.argv[1]))
except Exception as e: print("route_map unparsable", type(e).__name__); sys.exit()
def walk(x,p=""):
    if isinstance(x,dict):
        for k,v in x.items(): yield from walk(v,p+"/"+str(k))
    elif isinstance(x,list):
        for i,v in enumerate(x): yield from walk(v,p+"["+str(i)+"]")
    else: yield p,x
keys=set()
for p,v in walk(d):
    if re.search(r'(^|[/.\[])(api|mcp)([./\]-]|$)', p.lower()) or (isinstance(v,str) and re.search(r'\b(api|mcp)\.enclave\.host\b', v)):
        s=str(v)
        if re.match(r'^[a-z]+://', s): s0=urlsplit(s); s=f"{s0.scheme}://{s0.hostname}{':'+str(s0.port) if s0.port else ''}"
        if re.search(r'(?i)token|secret|key|cookie|auth', p): s="<redacted>"
        print("route", p[:120], "=", s[:120])
print("route_map_top_keys", list(d)[:12] if isinstance(d,dict) else type(d).__name__)
PY
rm -f /tmp/.rm.$$
for f in /etc/caddy/Caddyfile /etc/caddy/*.caddy; do [ -r "$f" ] && grep -nE '^[^#[:space:]][^{]*\{' "$f" | sed 's/{.*//' | sed "s|^|caddy_site $f:|"; done 2>/dev/null

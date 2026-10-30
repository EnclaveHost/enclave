echo "utc=$(date -u +%FT%TZ) host=$(hostname)"
cfgs=$(systemctl show enclave-network-provider -p ExecStart 2>/dev/null | grep -oE '/[^ ;=]+\.json' | sort -u)
echo "provider_config_paths=$(echo $cfgs)"
for c in $cfgs; do [ -r "$c" ] || { echo "unreadable $c"; continue; }; echo "config $c sha16=$(sha256sum "$c" | cut -c1-16)"; python3 - "$c" <<'PY'
import json,sys,re
from urllib.parse import urlsplit
d=json.load(open(sys.argv[1]))
def walk(x,p=""):
    if isinstance(x,dict):
        for k,v in x.items(): yield from walk(v,p+"/"+str(k))
    elif isinstance(x,list):
        for i,v in enumerate(x): yield from walk(v,p+"["+str(i)+"]")
    else: yield p,x
print(" top_keys", list(d)[:30] if isinstance(d,dict) else type(d).__name__)
for p,v in walk(d):
    pl=p.lower(); s=str(v)
    if re.search(r'(?i)token|secret|key|cookie|password|auth|cert|seal', p): continue
    if re.search(r'api|mcp|front|upstream|relay|chain|rpc|verifier|authority|origin|backend|proxy', pl) or re.search(r'\b(api|mcp)\.enclave\.host\b', s):
        if re.match(r'^[a-z]+://', s): u=urlsplit(s); s=f"{u.scheme}://{u.hostname}{':'+str(u.port) if u.port else ''}"
        print(" cfg", p[:100], "=", s[:100])
PY
done
curl -s --max-time 6 http://127.0.0.1:8188/v1/network/routes | python3 -c "import json,sys;d=json.load(sys.stdin);l=d.get('labels');print('labels', (sorted(l)[:40] if isinstance(l,dict) else type(l).__name__), 'n_deployments', len(d.get('deployments') or []))" 2>/dev/null

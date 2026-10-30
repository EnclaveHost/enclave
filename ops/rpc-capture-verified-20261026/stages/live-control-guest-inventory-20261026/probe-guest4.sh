S="sudo -n"
echo "utc=$(date -u +%FT%TZ) host=$(hostname)"
san='import sys,re
from urllib.parse import urlsplit
for l in sys.stdin:
  l=l.rstrip("\n")
  if "=" not in l: continue
  k,v=l.split("=",1); o=[]
  for x in re.split(r"[,\s]+",v.strip("\"'"'"'")):
    if re.match(r"^[a-z]+://",x):
      u=urlsplit(x); o.append(u.scheme+"://"+str(u.hostname)+(":"+str(u.port) if u.port else ""))
  print("  ",k,"= n=%d"%len(o),",".join(o) if o else "<no-url-value>")'
pid=$($S ss -ltnpH 'sport = :8100' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
echo "api_relay pid=$pid sanitized chain endpoints (process env, origins only):"
$S cat /proc/$pid/environ | tr '\0' '\n' | grep -E '^(BASE_RPC|SESSIONS_RPC|SESSIONS_PUBLIC_RPC|SECRETS_RELEASE_CATALOG_RPCS|CUSTODY_CHAIN_ID)=' | python3 -c "$san"
$S cat /proc/$pid/environ | tr '\0' '\n' | grep -E '^CUSTODY_CHAIN_ID=' | sed -E 's/^/   value /'
for d in /opt/nan-relay /opt/enclave-rpc /opt/enclave-recovery /opt/enclave-dns; do echo "srcdir $d real=$(readlink -f $d) git=$([ -d $d/.git ] && git -C $d rev-parse --short=12 HEAD 2>/dev/null || echo none) files=$(find $d -maxdepth 1 -type f | wc -l) newest=$(find $d -maxdepth 1 -type f -printf '%TY-%Tm-%TdT%TH:%TM\n' | sort | tail -1)"; done
echo "api-relay.js mentions: ENCLAVE_CHAIN_AUTHORITY=$(grep -c ENCLAVE_CHAIN_AUTHORITY /opt/nan-relay/api-relay.js) BASE_RPC=$(grep -c 'BASE_RPC\b' /opt/nan-relay/api-relay.js) chain-authority.mjs_import=$(grep -cE 'chain-authority' /opt/nan-relay/api-relay.js)"
echo "gateway.mjs sha16=$(sha256sum /opt/enclave-rpc/gateway.mjs|cut -c1-16) mentions ENCLAVE_CHAIN_AUTHORITY=$(grep -c ENCLAVE_CHAIN_AUTHORITY /opt/enclave-rpc/gateway.mjs) config_paths=$(grep -oE "['\"]/(etc|var/lib|opt)/[^'\"]+['\"]" /opt/enclave-rpc/gateway.mjs | tr -d "'\"" | sort -u | tr '\n' ,)"
gp=$($S ss -ltnpH 'sport = :8190' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
$S ss -tnpH state established 2>/dev/null | grep -E "pid=$gp," | awk '{print $4}' | sed -E 's/:[0-9]+$/ /;' | sort | uniq -c | awk '{print "gateway_outbound_peer",$2,"n="$1}'
$S ss -tnpH state established 2>/dev/null | grep -E "pid=$pid," | awk '{print $4}' | sed -E 's/:[0-9]+$//' | sort | uniq -c | awk '{print "api_relay_outbound_peer",$2,"n="$1}'
$S ss -ltnpH | awk '$4 ~ /^(127\.0\.0\.1|\[::1\]|0\.0\.0\.0|\*):/' | while read st rq sq loc peer proc; do echo "listen $loc $(echo "$proc"|grep -oE '"[^"]+"'|head -1) unit=$(p=$(echo "$proc"|grep -oE 'pid=[0-9]+'|head -1|cut -d= -f2); grep -oE '[^/]+\.service' /proc/$p/cgroup|tail -1)"; done | sort -u

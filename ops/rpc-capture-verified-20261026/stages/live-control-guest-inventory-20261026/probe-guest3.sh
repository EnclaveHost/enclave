S="sudo -n"
echo "utc=$(date -u +%FT%TZ) host=$(hostname)"
$S cat /etc/enclave-control-tls/caddy.json | python3 -c '
import sys,json
j=json.load(sys.stdin)
for sn,s in j["apps"]["http"]["servers"].items():
  def walk(rs,hosts,paths):
    for r in rs or []:
      h,p=hosts,paths
      for m in r.get("match",[]) or []:
        h=m.get("host",h); p=m.get("path",p)
      for hd in r.get("handle",[]) or []:
        if hd.get("handler")=="reverse_proxy": print("caddy_route server=%s hosts=%s paths=%s upstream=%s"%(sn,",".join(h or ["*"]),",".join(p or ["*"])[:120],",".join(u.get("dial","?") for u in hd.get("upstreams",[]))))
        if hd.get("handler")=="subroute": walk(hd.get("routes"),h,p)
  walk(s.get("routes"),None,None)'
KEYS='ENCLAVE_CHAIN_AUTHORITY|ENCLAVE_CHAIN_VERIFIER|ENCLAVE_CHAIN_TX_BACKEND|BASE_RPCS'
for port in 8190 8187 8100; do
  $S ss -ltnpH "sport = :$port" | while read -r st rq sq loc peer proc; do pid=$(echo "$proc"|grep -oE 'pid=[0-9]+'|head -1|cut -d= -f2)
    exe=$($S readlink /proc/$pid/exe); unit=$(grep -oE '[^/]+\.service' /proc/$pid/cgroup|tail -1); scr=$($S cat /proc/$pid/cmdline | tr '\0' '\n' | grep -m1 -E '^/[^ =]*\.(m?js|cjs|py)$')
    h=; [ -n "$scr" ] && h=$($S sha256sum "$scr"|cut -c1-16); cwd=$($S readlink /proc/$pid/cwd)
    echo "upstream $loc pid=$pid unit=$unit exe=$exe exe_sha16=$($S sha256sum $exe|cut -c1-16) script=$scr sha16=$h cwd=$cwd started=$(date -u -d @$(( $(date +%s) - $(ps -o etimes= -p $pid) )) +%FT%TZ)"
    d=$(dirname "${scr:-/x/x}"); for i in 1 2 3 4; do [ -f "$d/package.json" ] && { python3 -c "import json,sys;j=json.load(open(sys.argv[1]));print('  pkg',sys.argv[1],'name=%s version=%s'%(j.get('name'),j.get('version')))" "$d/package.json"; break; }; d=$(dirname "$d"); done
    for f in "$cwd"/{VERSION,.source-commit,release.json,SOURCE_COMMIT,MANIFEST.json} "$(dirname "${scr:-/x/x}")"/{VERSION,.source-commit,SOURCE_COMMIT}; do [ -f "$f" ] && echo "  version_file $f sha16=$(sha256sum "$f"|cut -c1-16) first=$(head -c 80 "$f" | tr -cd '[:alnum:]._:\- ')"; done | sort -u
    echo "  unit_state=$(systemctl show $unit -p ActiveState --value) since=$(systemctl show $unit -p ActiveEnterTimestamp --value) user=$(systemctl show $unit -p User --value) envfiles=$(systemctl show $unit -p EnvironmentFiles --value | awk '{print $1}' | tr '\n' ,)"
    { $S cat /proc/$pid/environ | tr '\0' '\n' | grep -E "^($KEYS)=" | sed 's/^/P:/'
      $S cat /proc/$pid/environ | tr '\0' '\n' | cut -d= -f1 | grep -E 'RPC|CHAIN|VERIFIER|BACKEND' | sort -u | sed 's/^/N:/'; } | python3 -c "
import sys,re
from urllib.parse import urlsplit
names=[];n=0
for l in sys.stdin:
  l=l.rstrip('\n')
  if l.startswith('N:'): names.append(l[2:]); continue
  k,v=l[2:].split('=',1); n+=1
  if k=='ENCLAVE_CHAIN_AUTHORITY': print('  authority(process env)',k,'=',v if v in('verifier','quorum','') else '<other>'); continue
  o=[]
  for x in re.split(r'[,\s]+',v):
    if re.match(r'^[a-z]+://',x): u=urlsplit(x); o.append(f'{u.scheme}://{u.hostname}'+(f':{u.port}' if u.port else ''))
  print('  authority(process env)',k,'= n=%d'%len(o),','.join(o))
print('  whitelisted_keys_found=%d chain_related_var_names=%s'%(n,','.join(names) or '-'))"
  done; [ -z "$($S ss -ltnH "sport = :$port")" ] && echo "upstream none_on_$port"
done

echo "utc=$(date -u +%FT%TZ) host=$(hostname) boot=$(uptime -s)"
for u in $(systemctl list-units --all --no-legend --plain 'enclave-control-tunnel-*' | awk '{print $1}'); do echo "tunnel_unit $u $(systemctl show $u -p ActiveState -p MainPID -p ActiveEnterTimestamp --no-pager | tr '\n' ' ') forwards=$(systemctl show $u -p ExecStart | grep -oE -- '-R [0-9.:]+' | tr '\n' ' ')"; done
for port in 30443 30080 1053; do ss -ltnpH "sport = :$port" 2>/dev/null | while read -r st rq sq loc peer proc; do pid=$(echo "$proc"|grep -oE 'pid=[0-9]+'|head -1|cut -d=-f2 2>/dev/null); pid=$(echo "$proc"|grep -oE 'pid=[0-9]+'|head -1|cut -d= -f2); exe=$(readlink /proc/$pid/exe 2>/dev/null); unit=$(grep -oE '[^/]+\.service' /proc/$pid/cgroup 2>/dev/null|tail -1); scr=$(tr '\0' '\n' </proc/$pid/cmdline 2>/dev/null | grep -m1 -E '^/[^ =]*\.(m?js|cjs)$'); h=; [ -n "$scr" ] && h=$(sha256sum "$scr"|cut -c1-16); echo "target_listen $loc comm=$(echo "$proc"|grep -oE '"[^"]+"'|head -1) pid=$pid unit=$unit exe=$exe script=$scr sha16=$h"; done; [ -z "$(ss -ltnH "sport = :$port")" ] && echo "target_listen none_on_$port"; done
for unit in $(ss -ltnpH '( sport = :30443 or sport = :30080 )' 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u | while read p; do grep -oE '[^/]+\.service' /proc/$p/cgroup|tail -1; done | sort -u); do
  echo "unit_info $unit fragment=$(systemctl show $unit -p FragmentPath --value) envfiles=$(systemctl show $unit -p EnvironmentFiles --value | awk '{print $1}' | tr '\n' ,)"
  systemctl show $unit -p Environment --value | tr ' ' '\n' | grep -E '^(ENCLAVE_CHAIN_AUTHORITY|ENCLAVE_CHAIN_VERIFIER|ENCLAVE_CHAIN_TX_BACKEND|BASE_RPCS|RPC_URLS?|UPSTREAM)=' | python3 -c "
import sys,re
from urllib.parse import urlsplit
for l in sys.stdin:
  k,v=l.strip().split('=',1)
  if k=='ENCLAVE_CHAIN_AUTHORITY': print(' env',k,'=',v if v in('verifier','quorum','') else '<other>'); continue
  o=[]
  for x in re.split(r'[,\s]+',v):
    if re.match(r'^[a-z]+://',x): u=urlsplit(x); o.append(f'{u.scheme}://{u.hostname}'+(f':{u.port}' if u.port else ''))
  print(' env',k,'= n=%d'%len(o),','.join(o))"
done

S=""; sudo -n true 2>/dev/null && S="sudo -n"
echo "utc=$(date -u +%FT%TZ) host=$(hostname) boot=$(uptime -s) sudo=$([ -n "$S" ] && echo yes || echo no)"
for u in $(systemctl list-units --all --no-legend --plain 'enclave-control-tunnel-*' | awk '{print $1}'); do echo "tunnel_unit $u $(systemctl show $u -p ActiveState -p SubState -p MainPID -p ActiveEnterTimestamp -p NRestarts --no-pager | tr '\n' ' ') forwards=$(systemctl show $u -p ExecStart | grep -oE -- '-R [0-9.:]+' | tr '\n' ' ') dest=$(systemctl show $u -p ExecStart | grep -oE 'enclave-control-tunnel@[0-9a-z.\-]+' | head -1)"; done
units=""
for port in 30443 30080 1053; do
  out=$($S ss -lntupH "sport = :$port" 2>/dev/null)
  [ -z "$out" ] && { echo "target_listen none_on_$port"; continue; }
  echo "$out" | while read -r proto st rq sq loc peer proc; do pid=$(echo "$proc"|grep -oE 'pid=[0-9]+'|head -1|cut -d= -f2)
    exe=$($S readlink /proc/$pid/exe); unit=$(grep -oE '[^/]+\.service' /proc/$pid/cgroup 2>/dev/null|tail -1)
    scr=$($S cat /proc/$pid/cmdline 2>/dev/null | tr '\0' '\n' | grep -m1 -E '^/[^ =]*\.(m?js|cjs|py)$'); h=; [ -n "$scr" ] && h=$($S sha256sum "$scr"|cut -c1-16)
    cwd=$($S readlink /proc/$pid/cwd); eh=$($S sha256sum "$exe" 2>/dev/null|cut -c1-16)
    echo "target_listen $proto $loc comm=$(echo "$proc"|grep -oE '"[^"]+"'|head -1) pid=$pid unit=$unit exe=$exe exe_sha16=$eh script=$scr sha16=$h cwd=$cwd"
    d=$(dirname "${scr:-/nonexistent/x}"); for i in 1 2 3 4; do [ -f "$d/package.json" ] && { python3 -c "import json,sys;j=json.load(open(sys.argv[1]));print('  pkg',sys.argv[1],'name=%s version=%s'%(j.get('name'),j.get('version')))" "$d/package.json" 2>/dev/null; break; }; d=$(dirname "$d"); done
    for f in "$(dirname "${scr:-/x/x}")"/{VERSION,RELEASE,.source-commit,release.json,SOURCE_COMMIT} "$cwd"/{VERSION,.source-commit,release.json}; do [ -f "$f" ] && echo "  version_file $f sha16=$(sha256sum "$f"|cut -c1-16) first=$(head -c 80 "$f" | tr -cd '[:alnum:]._:\- ' )"; done
  done
done
for unit in $($S ss -lntupH '( sport = :30443 or sport = :30080 or sport = :1053 )' 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u | while read p; do grep -oE '[^/]+\.service' /proc/$p/cgroup|tail -1; done | sort -u); do
  echo "unit_info $unit state=$(systemctl show $unit -p ActiveState --value) since=$(systemctl show $unit -p ActiveEnterTimestamp --value) fragment=$(systemctl show $unit -p FragmentPath --value) user=$(systemctl show $unit -p User --value) envfiles=$(systemctl show $unit -p EnvironmentFiles --value | awk '{print $1}' | tr '\n' ,)"
  { systemctl show $unit -p Environment --value | tr ' ' '\n'
    for ef in $(systemctl show $unit -p EnvironmentFiles --value | awk '{print $1}'); do $S grep -hE '^(export )?(ENCLAVE_CHAIN_AUTHORITY|ENCLAVE_CHAIN_VERIFIER|ENCLAVE_CHAIN_TX_BACKEND|BASE_RPCS)=' "$ef" 2>/dev/null | sed 's/^export //; s/^/F:/'; done
  } | grep -E '^(F:)?(ENCLAVE_CHAIN_AUTHORITY|ENCLAVE_CHAIN_VERIFIER|ENCLAVE_CHAIN_TX_BACKEND|BASE_RPCS)=' | python3 -c "
import sys,re
from urllib.parse import urlsplit
seen=0
for l in sys.stdin:
  l=l.strip(); src='envfile' if l.startswith('F:') else 'unit'; l=l[2:] if l.startswith('F:') else l
  k,v=l.split('=',1); v=v.strip('\"\''); seen+=1
  if k=='ENCLAVE_CHAIN_AUTHORITY': print('  authority',src,k,'=',v if v in('verifier','quorum','') else '<other>'); continue
  o=[]
  for x in re.split(r'[,\s]+',v):
    if re.match(r'^[a-z]+://',x): u=urlsplit(x); o.append(f'{u.scheme}://{u.hostname}'+(f':{u.port}' if u.port else ''))
  print('  authority',src,k,'= n=%d'%len(o),','.join(o))
print('  authority_keys_found=%d'%seen)"
done

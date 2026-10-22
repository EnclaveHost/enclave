#!/usr/bin/env bash
# READ-ONLY control VM: enclave-dns listeners (bind addresses only), eth0 IPv4, unit state, and its /health reduced to
# non-secret counts/flags. No env, no config file, no key, no TXT value.
cd /home/steven/Documents/Codex/2026-10-18/wo
timeout 60 ssh -p32423 -o BatchMode=yes -o ConnectTimeout=10 -o UserKnownHostsFile=work/control-vm/known_hosts -i /home/steven/.ssh/minipc controladmin@127.0.0.1 'bash -s' <<'R'
date -u +%FT%TZ
echo "eth0: $(ip -4 -o addr show eth0 | awk "{print \$4}")"
for u in enclave-dns enclave-api-relay; do echo "$u: $(systemctl is-active $u) pid=$(systemctl show -p MainPID --value $u)"; done
P=$(systemctl show -p MainPID --value enclave-dns)
sudo ss -Hlntup 2>/dev/null | grep "pid=$P," | awk "{print \$1, \$5}" | sort -u
for port in $(sudo ss -Hlntp 2>/dev/null | grep "pid=$P," | awk "{print \$4}" | sed "s/.*://" | sort -u); do
  h=$(curl -s -m 3 http://127.0.0.1:$port/health 2>/dev/null) && echo "$h" | python3 -c "import json,sys;d=json.load(sys.stdin);print('health port',$port,{k:d.get(k) for k in ('ok','readOnly','zones','deployments','txtRecords','routeLabels','nsName','serial')})" 2>/dev/null
done
echo "ufw: $(sudo ufw status 2>/dev/null | head -1)"
systemctl list-units --no-legend 'enclave-control-tunnel*' 2>/dev/null | awk "{print \$1, \$3, \$4}"
R

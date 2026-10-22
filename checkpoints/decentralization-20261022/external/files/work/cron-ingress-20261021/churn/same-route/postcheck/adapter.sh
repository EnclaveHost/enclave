#!/usr/bin/env bash
# READ-ONLY: where does https://7ae476a3.app.enclave.host/ stall? Phase timings via each signed route address and normal DNS.
H=7ae476a3.app.enclave.host
W='code=%{http_code} verify=%{ssl_verify_result} ip=%{remote_ip} dns=%{time_namelookup} tcp=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total}'
for a in 1 2; do
  for ip in 165.245.191.129 134.209.248.172 normal; do
    if [ $ip = normal ]; then r=$(curl -sS -o /dev/null --max-time 15 -w "$W" https://$H/ 2>&1); else r=$(curl -sS -o /dev/null --max-time 15 --resolve $H:443:$ip -w "$W" https://$H/ 2>&1); fi
    echo "$(date -u +%TZ) attempt=$a via=$ip $r" | tr '\n' ' '; echo
  done
done
echo "dns: $(dig +short +time=3 +tries=1 $H A | tr '\n' ' ')"

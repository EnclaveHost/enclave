#!/usr/bin/env bash
# READ-ONLY public GETs: adapter status/health via each signed route address and via ipfs.enclave.host.
H=7ae476a3.app.enclave.host
W='\n  -> code=%{http_code} ip=%{remote_ip} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total}\n'
for ip in 134.209.248.172 165.245.191.129; do
  echo "== $H/api/status via $ip $(date -u +%TZ)"; curl -sS --max-time 25 --resolve $H:443:$ip -w "$W" https://$H/api/status | head -c 1500
  echo "== $H/healthz via $ip"; curl -sS --max-time 25 --resolve $H:443:$ip -w "$W" https://$H/healthz
done
echo "== ipfs.enclave.host/api/status $(date -u +%TZ)"; curl -sS --max-time 25 -w "$W" https://ipfs.enclave.host/api/status | head -c 1500
echo "== dns ipfs.enclave.host: $(dig +short +time=3 +tries=1 ipfs.enclave.host A | tr '\n' ' ')"
